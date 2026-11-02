package robot

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFriendMomentsVisibilityPage(t *testing.T) {
	for _, code := range []int{0, 207, 2001, 2004} {
		for _, withPosts := range []bool{false, true} {
			t.Run(fmt.Sprintf("ret-%d/posts-%t", code, withPosts), func(t *testing.T) {
				posts := `[]`
				if withPosts {
					posts = `[{"Id":18446744073709551600,"CreateTime":1792738000}]`
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var request FriendCircleGetDetailRequest
					if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
						t.Error(err)
					}
					if r.Method != "POST" || r.URL.Path != "/api"+FriendCircleGetDetail || request.Wxid != "qa-self" || request.Towxid != "qa-friend" || request.Maxid != 18446744073709551601 {
						t.Error("friend or cursor changed in protocol request")
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprintf(w, `{"Code":0,"Data":{"BaseResponse":{"ret":%d},"ObjectList":%s,"RetTips":["朋友仅展示最近三天的朋友圈"],"FristPageMd5":"page-md5"}}`, code, posts)
				}))
				defer server.Close()
				client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
				page, err := client.FriendCircleGetDetail(FriendCircleGetDetailRequest{Wxid: "qa-self", Towxid: "qa-friend", Maxid: 18446744073709551601})
				if err != nil {
					t.Fatal(err)
				}
				if len(page.RetTips) != 1 || *page.FristPageMd5 != "page-md5" || (len(page.ObjectList) == 1) != withPosts {
					t.Fatal("visible posts or visibility metadata lost")
				}
				if withPosts && *page.ObjectList[0].Id != 18446744073709551600 {
					t.Fatal("moment ID lost precision")
				}
				if code != 0 && client.BaseResponseErrCheck(page.BaseResponse) == nil {
					t.Fatal("visibility exception leaked into other endpoints")
				}
			})
		}
	}
}

func TestFriendMomentsRejectsFailures(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"empty", `{}`, 200},
		{"http error", `{}`, 502},
		{"invalid json", `{`, 200},
		{"logged out", `{"Code":-7}`, 200},
		{"unknown outer code", `{"Code":999,"Data":{"BaseResponse":{"ret":2004},"RetTips":["tip"]}}`, 200},
		{"unknown base code", `{"Code":0,"Data":{"BaseResponse":{"ret":999},"RetTips":["tip"]}}`, 200},
		{"visibility without tips", `{"Code":0,"Data":{"BaseResponse":{"ret":2004}}}`, 200},
		{"visibility blank tips", `{"Code":0,"Data":{"BaseResponse":{"ret":2004},"RetTips":[" "]}}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
			if _, err := client.FriendCircleGetDetail(FriendCircleGetDetailRequest{Towxid: "qa-friend"}); err == nil {
				t.Fatal("upstream failure accepted as empty Moments page")
			}
		})
	}
}
