package robot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatRoomMemberSnapshotValidation(t *testing.T) {
	valid := `{"Code":0,"Data":{"BaseResponse":{"ret":0},"ChatroomUserName":"room","NewChatroomData":{"MemberCount":1,"ChatRoomMember":[{"UserName":"member","NickName":"Name","SmallHeadImgUrl":"avatar.png"}]}}}`
	for _, tc := range []struct {
		name, body string
		status     int
		wantErr    bool
	}{
		{"complete", valid, 200, false},
		{"http-error", valid, 502, true},
		{"empty", "{}", 200, true},
		{"unknown-code", strings.Replace(valid, `"Code":0`, `"Code":999`, 1), 200, true},
		{"base-error", strings.Replace(valid, `"ret":0`, `"ret":-1`, 1), 200, true},
		{"wrong-room", strings.Replace(valid, `"room"`, `"other"`, 1), 200, true},
		{"partial", strings.Replace(valid, `"MemberCount":1`, `"MemberCount":2`, 1), 200, true},
		{"blank-id", strings.Replace(valid, `"member"`, `""`, 1), 200, true},
		{"duplicate", `{"Code":0,"Data":{"ChatroomUserName":"room","NewChatroomData":{"MemberCount":2,"ChatRoomMember":[{"UserName":"same"},{"UserName":"same"}]}}}`, 200, true},
		{"empty-list", `{"Code":0,"Data":{"ChatroomUserName":"room","NewChatroomData":{"MemberCount":0,"ChatRoomMember":[]}}}`, 200, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
			members, err := client.GetChatRoomMemberDetailContext(context.Background(), "robot", "room")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v, wantErr=%v", err, tc.wantErr)
			}
			if !tc.wantErr && (len(members) != 1 || members[0].NickName != "Name" || members[0].SmallHeadImgUrl != "avatar.png") {
				t.Fatal("profile not returned")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := NewClient(WechatDomain("127.0.0.1:1"), ProxyInfo{})
	if _, err := client.GetChatRoomMemberDetailContext(ctx, "robot", "room"); err == nil {
		t.Fatal("cancelled refresh succeeded")
	}
}
