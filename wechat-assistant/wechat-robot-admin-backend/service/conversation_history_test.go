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

func TestConversationHistoryPaging(t *testing.T) {
	expectedSize := "50"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("page_size") != expectedSize || q.Get("page_index") != "2" || q.Get("contact_id") != "test-peer" {
			t.Errorf("conversation pagination changed: %v", q)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"code":200,"data":{"items":[{"id":7,"content":"kept"}],"total":75}}`))
	}))
	defer upstream.Close()
	t.Setenv("DEV_ROBOT_CLIENT_URL", upstream.URL)
	for _, tc := range []struct {
		size     int
		expected string
	}{{50, "50"}, {20, "20"}, {0, "20"}, {1000, "100"}} {
		expectedSize = tc.expected
		items, total, err := NewChatHistoryService(context.Background()).GetChatHistory(dto.ChatHistoryRequest{ContactID: "test-peer"}, appx.Pager{PageIndex: 2, PageSize: tc.size}, &model.Robot{})
		if err != nil || total != 75 || len(items) != 1 || items[0].Content != "kept" {
			t.Fatal("conversation response lost", err)
		}
	}
}
