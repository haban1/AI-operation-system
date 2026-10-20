package service

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wechat-robot-client/dto"
	"wechat-robot-client/pkg/robot"
	"wechat-robot-client/vars"
)

func TestMomentPostTextProtocol(t *testing.T) {
	previous := vars.RobotRuntime
	t.Cleanup(func() { vars.RobotRuntime = previous })
	for _, tc := range []struct {
		name, shareType string
		privacy         uint32
		ret             int
	}{
		{"public", "public", 0, 0},
		{"private", "private", 1, 0},
		{"wechat rejects", "public", 0, -2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/FriendCircle/Messages" || r.Method != http.MethodPost {
					t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				}
				var req robot.FriendCircleMessagesRequest
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
					t.Error(err)
				}
				var timeline robot.TimelineObject
				if err := xml.Unmarshal([]byte(req.Content), &timeline); err != nil {
					t.Error(err)
				}
				if req.Wxid != "wxid_local_test" || timeline.Username != req.Wxid || timeline.ContentDesc != "嗨 & <测试>" || timeline.ContentObject.ContentStyle != 2 {
					t.Error("text post was not forwarded correctly")
				}
				if req.Privacy != tc.privacy || timeline.Private != tc.privacy {
					t.Error("privacy was not preserved in both request and XML")
				}
				if strings.Contains(req.Content, "<weappInfo>") || strings.Contains(req.Content, "<streamvideo>") {
					t.Error("text post contains empty attachment objects")
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"Success":true,"Code":0,"Data":{"BaseResponse":{"ret":%d},"SnsObject":{"Id":123}}}`, tc.ret)
			}))
			defer server.Close()
			vars.RobotRuntime = &robot.Robot{
				WxID:   "wxid_local_test",
				Client: robot.NewClient(robot.WechatDomain(strings.TrimPrefix(server.URL, "http://")), robot.ProxyInfo{}),
			}
			service := &MomentsService{ctx: context.Background()}
			resp, err := service.FriendCirclePost(dto.MomentPostRequest{Content: "嗨 & <测试>", ShareType: tc.shareType})
			if tc.ret == 0 {
				if err != nil || resp.SnsObject == nil || resp.SnsObject.Id == nil || *resp.SnsObject.Id != 123 {
					t.Fatalf("success response lost: %v, %#v", err, resp)
				}
			} else if err == nil || !strings.Contains(err.Error(), "-2") {
				t.Fatalf("WeChat failure must reach the caller: %v", err)
			}
			if calls != 1 {
				t.Fatalf("publish must not retry automatically; calls=%d", calls)
			}
		})
	}
}
