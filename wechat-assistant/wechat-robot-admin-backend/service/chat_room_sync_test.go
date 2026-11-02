package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"wechat-robot-admin-backend/dto"
	"wechat-robot-admin-backend/model"
	"wechat-robot-admin-backend/pkg/appx"
)

func TestChatRoomRefreshProxy(t *testing.T) {
	fail := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/chat-room/members/sync":
			if fail {
				w.Write([]byte(`{"code":500,"message":"offline"}`))
				return
			}
			w.Write([]byte(`{"code":200,"data":null}`))
		case "/chat-room/members":
			if r.URL.Query().Get("membership") != "current" || r.URL.Query().Get("chat_room_id") != "room" {
				t.Error("membership/room filter was not forwarded")
			}
			w.Write([]byte(`{"code":200,"data":{"items":[{"nickname":"Name","avatar":"avatar.png"}],"total":1}}`))
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
		}
	}))
	defer server.Close()
	t.Setenv("DEV_ROBOT_CLIENT_URL", server.URL)
	svc := NewChatRoomService(context.Background())
	bot := &model.Robot{}
	if err := svc.SyncChatRoomMembers(bot, "room"); err != nil {
		t.Fatal(err)
	}
	fail = true
	if err := svc.SyncChatRoomMembers(bot, "room"); err == nil {
		t.Fatal("failed sync reported success")
	}
	items, total, err := svc.GetChatRoomMembers(dto.ChatRoomMemberListRequest{ChatRoomID: "room", Membership: "current"}, appx.Pager{PageSize: 20}, bot)
	if err != nil || total != 1 || len(items) != 1 || items[0].Nickname != "Name" || items[0].Avatar != "avatar.png" {
		t.Fatalf("list/profile response lost: items=%+v total=%d err=%v", items, total, err)
	}
}
