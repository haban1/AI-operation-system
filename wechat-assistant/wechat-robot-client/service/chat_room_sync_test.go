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

func TestChatRoomMemberRefresh(t *testing.T) {
	type testMember struct {
		model.ChatRoomMember
		ID int64 `gorm:"column:id;type:integer;primaryKey;autoIncrement"`
	}
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	if err := db.Table("chat_room_members").AutoMigrate(&testMember{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE chat_room_settings (id INTEGER PRIMARY KEY, chat_room_id TEXT, wxhb_notify_member_list TEXT, leave_chat_room_alert_enabled BOOLEAN, leave_chat_room_alert_text TEXT)`).Error; err != nil {
		t.Fatal(err)
	}
	db.Exec(`INSERT INTO chat_room_settings VALUES (1, 'room@chatroom', 'kept,departed', 1, '{placeholder} left')`)
	oldDB, oldRobot := vars.DB, vars.RobotRuntime
	t.Cleanup(func() { vars.DB, vars.RobotRuntime = oldDB, oldRobot })
	vars.DB = db
	for _, m := range []model.ChatRoomMember{
		{ChatRoomID: "room@chatroom", WechatID: "kept", Nickname: "old name", Avatar: "old.png", JoinedAt: 10, LastActiveAt: 20, IsAdmin: utils.BoolPtr(true), Score: utils.Int64Ptr(42)},
		{ChatRoomID: "room@chatroom", WechatID: "departed", Nickname: "departed name", Remark: "search-me"},
		{ChatRoomID: "room@chatroom", WechatID: "rejoined", Nickname: "returning", IsLeaved: utils.BoolPtr(true), LeavedAt: utils.Int64Ptr(30), JoinedAt: 10},
		{ChatRoomID: "other@chatroom", WechatID: "other", Remark: "search-me"},
	} {
		if err := db.Create(&m).Error; err != nil {
			t.Fatal(err)
		}
	}
	members := []robot.ChatRoomMember{
		{UserName: "kept", NickName: "new name", DisplayName: utils.StringPtr("group name"), SmallHeadImgUrl: "small.png"},
		{UserName: "rejoined", NickName: "returning", BigHeadImgUrl: "big.png"},
		{UserName: "new", NickName: "new member", SmallHeadImgUrl: "new.png"},
	}
	fail, partial := false, false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// A silent UI refresh must never send departure alerts, even when enabled.
		if !strings.HasSuffix(r.URL.Path, robot.GroupGetChatRoomMemberDetail) {
			t.Errorf("unexpected protocol request: %s", r.URL.Path)
			w.WriteHeader(500)
			return
		}
		if fail {
			w.Write([]byte(`{"Code":-13,"Message":"offline"}`))
			return
		}
		count := len(members)
		if partial {
			count++
		}
		json.NewEncoder(w).Encode(robot.ClientResponse[robot.ChatRoomMemberDetail]{Code: 0, Success: true, Data: robot.ChatRoomMemberDetail{
			ChatroomUserName: "room@chatroom", NewChatroomData: robot.NewChatroomData{MemberCount: count, ChatRoomMember: members},
		}})
	}))
	defer server.Close()
	vars.RobotRuntime = &robot.Robot{WxID: "robot", Client: robot.NewClient(robot.WechatDomain(strings.TrimPrefix(server.URL, "http://")), robot.ProxyInfo{})}
	svc := NewChatRoomService(context.Background())
	get := func(id string) *model.ChatRoomMember {
		t.Helper()
		m, err := svc.crmRepo.GetChatRoomMember("room@chatroom", id)
		if err != nil || m == nil {
			t.Fatalf("member %s missing: %v", id, err)
		}
		return m
	}
	if err := svc.RefreshChatRoomMembers("room@chatroom"); err != nil {
		t.Fatal(err)
	}
	kept := get("kept")
	if kept.Nickname != "new name" || kept.Remark != "group name" || kept.Avatar != "small.png" || !*kept.IsAdmin || *kept.Score != 42 || kept.JoinedAt != 10 || kept.LastActiveAt != 20 {
		t.Fatalf("profile or local settings incorrect: %+v", kept)
	}
	if m := get("departed"); !*m.IsLeaved || m.LeavedAt == nil {
		t.Fatal("departure not reconciled")
	}
	if m := get("rejoined"); *m.IsLeaved || m.LeavedAt != nil || m.JoinedAt <= 10 || m.Avatar != "big.png" {
		t.Fatal("rejoin not reconciled")
	}
	if m := get("new"); m.Nickname != "new member" || m.Avatar != "new.png" || *m.IsLeaved {
		t.Fatal("new profile not saved")
	}
	var notify string
	db.Table("chat_room_settings").Select("wxhb_notify_member_list").Row().Scan(&notify)
	if notify != "kept" {
		t.Fatalf("departed notification target retained: %s", notify)
	}
	for _, tc := range []struct {
		membership, keyword string
		count               int64
	}{
		{"current", "", 3}, {"left", "", 1}, {"all", "", 4}, {"current", "search-me", 0}, {"left", "search-me", 1},
	} {
		_, total, err := svc.GetChatRoomMembers(dto.ChatRoomMemberListRequest{ChatRoomID: "room@chatroom", Membership: tc.membership, Keyword: tc.keyword}, appx.Pager{PageSize: 20})
		if err != nil || total != tc.count {
			t.Fatalf("filter %+v: total=%d err=%v", tc, total, err)
		}
	}
	list, err := svc.GetNotLeftMembers(dto.ChatRoomMemberListRequest{ChatRoomID: "room@chatroom", Keyword: "search-me"})
	if err != nil || len(list) != 0 {
		t.Fatal("search bypassed room or membership filter")
	}
	// Failed/partial snapshots leave the successful membership and profile intact.
	members = members[:1]
	members[0].NickName = "must not persist"
	for _, mode := range []string{"failed", "partial"} {
		fail, partial = mode == "failed", mode == "partial"
		if err := svc.RefreshChatRoomMembers("room@chatroom"); err == nil {
			t.Fatalf("%s snapshot succeeded", mode)
		}
		if get("kept").Nickname != "new name" || *get("new").IsLeaved {
			t.Fatal("invalid snapshot changed members")
		}
	}
	fail, partial = false, false
	// A later DB failure rolls back even profile updates made earlier in the transaction.
	if err := db.Exec(`CREATE TRIGGER reject_new BEFORE INSERT ON chat_room_members WHEN NEW.wechat_id='reject' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	members = append(members, robot.ChatRoomMember{UserName: "reject", NickName: "rejected"})
	if err := svc.RefreshChatRoomMembers("room@chatroom"); err == nil {
		t.Fatal("expected transaction error")
	}
	if get("kept").Nickname != "new name" || *get("new").IsLeaved {
		t.Fatal("failed transaction was partially committed")
	}
	// Repeated snapshots do not duplicate records; absent profile fields preserve cached data.
	members = []robot.ChatRoomMember{{UserName: "kept"}, {UserName: "new"}, {UserName: "rejoined"}}
	if err := svc.RefreshChatRoomMembers("room@chatroom"); err != nil {
		t.Fatal(err)
	}
	if m := get("kept"); m.Avatar != "small.png" || m.Nickname != "new name" || m.Remark != "" {
		t.Fatal("missing profile handling failed")
	}
	var total int64
	db.Model(&model.ChatRoomMember{}).Count(&total)
	if total != 5 {
		t.Fatalf("duplicate records: %d", total)
	}
}
