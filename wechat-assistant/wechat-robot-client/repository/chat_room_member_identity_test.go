package repository_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"wechat-robot-client/dto"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/appx"
	"wechat-robot-client/repository"
	"wechat-robot-client/utils"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func memberIdentityTestDB(t *testing.T, legacy bool) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	type testMember struct {
		model.ChatRoomMember
		ID int64 `gorm:"column:id;type:integer;primaryKey;autoIncrement"`
	}
	if err := db.Table("chat_room_members").AutoMigrate(&testMember{}); err != nil {
		t.Fatal(err)
	}
	if legacy {
		if err := db.Migrator().DropIndex(&model.ChatRoomMember{}, repository.ChatRoomMemberIdentityIndex); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestConsolidateDuplicateChatRoomMembers(t *testing.T) {
	db := memberIdentityTestDB(t, true)
	for _, member := range []model.ChatRoomMember{
		{ID: 1, ChatRoomID: "a", WechatID: "same", Score: utils.Int64Ptr(7), IsAdmin: utils.BoolPtr(false), JoinedAt: 10, LastActiveAt: 20},
		{ID: 2, ChatRoomID: "a", WechatID: "same", Nickname: "same name", Avatar: "avatar.png", Score: utils.Int64Ptr(99), IsAdmin: utils.BoolPtr(true), IsBlacklisted: utils.BoolPtr(true), JoinedAt: 5, LastActiveAt: 50},
		{ID: 3, ChatRoomID: "a", WechatID: "different", Nickname: "same name"},
		{ID: 4, ChatRoomID: "b", WechatID: "same", Nickname: "another group"},
		{ID: 5, ChatRoomID: "a", WechatID: "left", IsLeaved: utils.BoolPtr(true)},
	} {
		if err := db.Create(&member).Error; err != nil {
			t.Fatal(err)
		}
	}
	// If consolidation fails, both the originals and the archive remain atomic.
	if err := db.Exec(`CREATE TRIGGER reject_duplicate_delete BEFORE DELETE ON chat_room_members BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ConsolidateDuplicateChatRoomMembers(context.Background(), db); err == nil {
		t.Fatal("expected rollback")
	}
	var count int64
	db.Model(&model.ChatRoomMember{}).Count(&count)
	if count != 5 {
		t.Fatalf("failed migration removed records: %d", count)
	}
	db.Model(&model.ChatRoomMemberDuplicate{}).Count(&count)
	if count != 0 {
		t.Fatal("failed migration committed archive")
	}
	db.Exec("DROP TRIGGER reject_duplicate_delete")
	removed, err := repository.ConsolidateDuplicateChatRoomMembers(context.Background(), db)
	if err != nil || removed != 1 {
		t.Fatalf("removed=%d err=%v", removed, err)
	}
	repo := repository.NewChatRoomMemberRepo(context.Background(), db)
	canonical, err := repo.GetChatRoomMember("a", "same")
	if err != nil || canonical.ID != 1 || *canonical.Score != 7 || *canonical.IsAdmin || *canonical.IsBlacklisted {
		t.Fatalf("canonical ID/settings changed: %+v err=%v", canonical, err)
	}
	if canonical.Nickname != "same name" || canonical.Avatar != "avatar.png" || canonical.JoinedAt != 5 || canonical.LastActiveAt != 50 {
		t.Fatal("profile/activity not recovered")
	}
	var archive model.ChatRoomMemberDuplicate
	if err := db.First(&archive, "original_member_id = ?", 2).Error; err != nil {
		t.Fatal(err)
	}
	var original model.ChatRoomMember
	if err := json.Unmarshal([]byte(archive.MemberSnapshot), &original); err != nil {
		t.Fatal(err)
	}
	if original.ID != 2 || *original.Score != 99 || !*original.IsAdmin || archive.CanonicalMemberID != 1 {
		t.Fatal("original duplicate not preserved")
	}
	if removed, err = repository.ConsolidateDuplicateChatRoomMembers(context.Background(), db); err != nil || removed != 0 {
		t.Fatalf("migration not idempotent: %d %v", removed, err)
	}
	db.Model(&model.ChatRoomMemberDuplicate{}).Count(&count)
	if count != 2 {
		t.Fatalf("expected both originals archived, got %d", count)
	}
	if err := db.Migrator().CreateIndex(&model.ChatRoomMember{}, repository.ChatRoomMemberIdentityIndex); err != nil {
		t.Fatal(err)
	}
	// Distinct account IDs with the same name and the same account in another group survive.
	rows, total, err := repo.GetByChatRoomID(dto.ChatRoomMemberListRequest{ChatRoomID: "a", Membership: "current"}, appx.Pager{PageSize: 1})
	if err != nil || total != 2 || len(rows) != 1 {
		t.Fatalf("pagination/count incorrect: total=%d rows=%d err=%v", total, len(rows), err)
	}
	if total, err := repo.GetChatRoomMemberCount("a"); err != nil || total != 2 {
		t.Fatalf("active count=%d err=%v", total, err)
	}
	if members, err := repo.GetChatRoomMembers("a"); err != nil || len(members) != 2 {
		t.Fatal("left member leaked into current members")
	}
	other, err := repo.GetChatRoomMember("b", "same")
	if err != nil || other == nil || other.ID != 4 {
		t.Fatal("same account in another group was merged")
	}
}

func TestChatRoomMemberConcurrentCreate(t *testing.T) {
	db := memberIdentityTestDB(t, false)
	repo := repository.NewChatRoomMemberRepo(context.Background(), db)
	canonical := model.ChatRoomMember{ChatRoomID: "a", WechatID: "same", Nickname: "synced profile", Avatar: "avatar.png", Score: utils.Int64Ptr(12)}
	if err := repo.Create(&canonical); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			member := model.ChatRoomMember{ChatRoomID: "a", WechatID: "same"}
			if err := repo.Create(&member); err != nil {
				t.Errorf("concurrent insert: %v", err)
				return
			}
			if member.ID != canonical.ID {
				t.Errorf("insert returned noncanonical ID %d", member.ID)
			}
		}()
	}
	wg.Wait()
	var count int64
	db.Model(&model.ChatRoomMember{}).Count(&count)
	if count != 1 {
		t.Fatalf("duplicate rows: %d", count)
	}
	got, err := repo.GetChatRoomMember("a", "same")
	if err != nil || got.Nickname != "synced profile" || got.Avatar != "avatar.png" || *got.Score != 12 {
		t.Fatal("duplicate create overwrote profile/settings")
	}
	if err := db.Create(&model.ChatRoomMember{ChatRoomID: "a", WechatID: "same"}).Error; err == nil {
		t.Fatal("database allowed duplicate account")
	}
	if err := repo.Create(&model.ChatRoomMember{ChatRoomID: "b", WechatID: "same"}); err != nil {
		t.Fatal("same account in different group rejected")
	}
	if err := repo.Create(&model.ChatRoomMember{ChatRoomID: "a", WechatID: "different", Nickname: "synced profile"}); err != nil {
		t.Fatal("same name different account rejected")
	}
	if err := repo.Create(&model.ChatRoomMember{ChatRoomID: "a", WechatID: " "}); err == nil {
		t.Fatal("blank account ID accepted")
	}
}
