package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wechat-robot-client/dto"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/appx"
	"wechat-robot-client/pkg/robot"
	"wechat-robot-client/utils"
	"wechat-robot-client/vars"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestContactSyncMembership(t *testing.T) {
	// Override the MySQL enum for this isolated in-memory database.
	type testContact struct {
		model.Contact
		ID   int64  `gorm:"column:id;type:integer;primaryKey;autoIncrement"`
		Type string `gorm:"column:type;type:text"`
	}
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	if err := db.Table("contacts").AutoMigrate(&testContact{}); err != nil {
		t.Fatal(err)
	}
	oldDB, oldRobot := vars.DB, vars.RobotRuntime
	t.Cleanup(func() { vars.DB, vars.RobotRuntime = oldDB, oldRobot })
	vars.DB = db
	ids := []string{"kept"}
	failList, failDetail := false, false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, robot.FriendGetContactList) {
			if failList {
				w.Write([]byte(`{"Code":-13,"Message":"offline"}`))
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"Code": 0, "Data": map[string]any{
				"BaseResponse": map[string]int{"ret": 0}, "CountinueFlag": 0, "ContactUsernameList": ids,
			}})
			return
		}
		if !strings.HasSuffix(r.URL.Path, robot.FriendGetContactDetail) {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if failDetail {
			w.Write([]byte(`{"Code":0,"Data":{"BaseResponse":{"ret":0},"Ret":[],"ContactList":[]}}`))
			return
		}
		var req robot.GetContactDetailRequest
		json.NewDecoder(r.Body).Decode(&req)
		contacts := []robot.Contact{}
		ret := []int{}
		for _, id := range strings.Split(req.Towxids, ",") {
			contacts = append(contacts, robot.Contact{UserName: robot.SKBuiltinStringT{String: utils.StringPtr(id)}})
			ret = append(ret, 0)
		}
		json.NewEncoder(w).Encode(map[string]any{"Code": 0, "Data": robot.GetContactResponse{ContactList: contacts, Ret: ret}})
	}))
	defer server.Close()
	vars.RobotRuntime = &robot.Robot{Client: robot.NewClient(robot.WechatDomain(strings.TrimPrefix(server.URL, "http://")), robot.ProxyInfo{}), Status: model.RobotStatusOnline}
	svc := NewContactService(context.Background())
	for _, contact := range []model.Contact{
		{WechatID: "kept", Type: model.ContactTypeFriend, Status: utils.IntPtr(0)},
		{WechatID: "deleted", Type: model.ContactTypeFriend, Status: utils.IntPtr(0), Remark: "saved remark"},
		{WechatID: "old@chatroom", Type: model.ContactTypeChatRoom, Status: utils.IntPtr(0)},
		{WechatID: "gh_official", Type: model.ContactTypeOfficialAccount, Status: utils.IntPtr(0)},
	} {
		if err := svc.ctRepo.Create(&contact); err != nil {
			t.Fatal(err)
		}
	}
	assertStatus := func(id string, want int) {
		t.Helper()
		contact, err := svc.ctRepo.GetContact(id)
		if err != nil || contact == nil || contact.Status == nil || *contact.Status != want {
			t.Fatalf("%s: contact=%+v err=%v, want status %d", id, contact, err, want)
		}
	}
	if err := svc.SyncContact(false); err != nil {
		t.Fatal(err)
	}
	assertStatus("kept", 0)
	assertStatus("deleted", model.ContactStatusMissing)
	assertStatus("old@chatroom", 0)
	assertStatus("gh_official", 0)
	// A delayed profile update must not resurrect a deleted friend.
	if err := svc.SyncContactByContactIDs([]string{"deleted"}); err != nil {
		t.Fatal(err)
	}
	assertStatus("deleted", model.ContactStatusMissing)
	friends, total, err := svc.GetContacts(dto.ContactListRequest{Type: "friend"}, appx.Pager{PageSize: 100})
	if err != nil || total != 1 || len(friends) != 1 || friends[0].WechatID != "kept" {
		t.Fatalf("friends=%v total=%d err=%v", friends, total, err)
	}
	// Keyword matching must not bypass the status predicate.
	db.Model(&model.Contact{}).Where("wechat_id = ?", "deleted").Update("remark", "saved remark")
	_, total, err = svc.GetContacts(dto.ContactListRequest{Type: "friend", Keyword: "saved"}, appx.Pager{PageSize: 100})
	if err != nil || total != 0 {
		t.Fatalf("inactive friend matched search: total=%d err=%v", total, err)
	}
	// Failed list or detail requests preserve membership of existing friends.
	ids = []string{"deleted"}
	failList = true
	if err := svc.SyncContact(false); err == nil {
		t.Fatal("expected list error")
	}
	assertStatus("kept", 0)
	failList, failDetail = false, true
	if err := svc.SyncContact(false); err == nil {
		t.Fatal("expected detail error")
	}
	assertStatus("kept", 0)
	failDetail = false
	// A re-added friend is restored by a complete successful snapshot.
	ids = []string{"kept", "deleted"}
	if err := svc.SyncContact(false); err != nil {
		t.Fatal(err)
	}
	assertStatus("deleted", 0)
	if err := svc.DeleteContactByContactID("deleted"); err != nil {
		t.Fatal(err)
	}
	assertStatus("deleted", model.ContactStatusMissing)
	if err := svc.SyncContactByContactIDs([]string{"deleted"}); err != nil {
		t.Fatal(err)
	}
	assertStatus("deleted", model.ContactStatusMissing)
	// An explicitly empty snapshot invalidates friends, preserving other types.
	ids = []string{}
	if err := svc.SyncContact(false); err != nil {
		t.Fatal(err)
	}
	assertStatus("kept", model.ContactStatusMissing)
	assertStatus("old@chatroom", 0)
	assertStatus("gh_official", 0)
	vars.RobotRuntime.Status = model.RobotStatusOffline
	if err := svc.SyncContact(false); err == nil {
		t.Fatal("offline sync reported success")
	}
	var all []model.Contact
	db.Find(&all)
	if len(all) != 4 {
		t.Fatalf("history records removed: %d", len(all))
	}
}
