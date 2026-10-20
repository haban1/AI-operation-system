package robot

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestContactListCompleteSnapshot(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var req GetContactListRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Error(err)
		}
		if r.URL.Path != "/api"+FriendGetContactList || req.Wxid != "robot" {
			t.Errorf("unexpected request: %s %+v", r.URL.Path, req)
		}
		w.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			w.Write([]byte(`{"Code":0,"Data":{"BaseResponse":{"ret":0},"CountinueFlag":1,"CurrentWxcontactSeq":8,"CurrentChatRoomContactSeq":3,"ContactUsernameList":["a","b"]}}`))
		} else {
			if req.CurrentWxcontactSeq != 8 || req.CurrentChatRoomContactSeq != 3 {
				t.Errorf("lost cursors: %+v", req)
			}
			w.Write([]byte(`{"Code":0,"Data":{"BaseResponse":{"ret":0},"CountinueFlag":0,"ContactUsernameList":["b","c"]}}`))
		}
	}))
	defer server.Close()
	client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
	ids, err := client.GetContactList("robot")
	if err != nil || !reflect.DeepEqual(ids, []string{"a", "b", "c"}) || requests != 2 {
		t.Fatalf("ids=%v, requests=%d, err=%v", ids, requests, err)
	}
}

func TestContactListRejectsIncompleteSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name   string
		body   string
		status int
	}{
		{"missing data", `{"Code":0}`, 200},
		{"missing list", `{"Code":0,"Data":{"BaseResponse":{"ret":0},"CountinueFlag":0}}`, 200},
		{"missing completion", `{"Code":0,"Data":{"BaseResponse":{"ret":0},"ContactUsernameList":[]}}`, 200},
		{"missing base response", `{"Code":0,"Data":{"CountinueFlag":0,"ContactUsernameList":[]}}`, 200},
		{"protocol failure", `{"Code":0,"Data":{"BaseResponse":{"ret":-1},"CountinueFlag":0,"ContactUsernameList":[]}}`, 200},
		{"unknown error code", `{"Code":500,"Success":false}`, 200},
		{"http failure", `{}`, 503},
		{"invalid json", `{`, 200},
		{"repeated cursor", `{"Code":0,"Data":{"BaseResponse":{"ret":0},"CountinueFlag":1,"ContactUsernameList":["a"]}}`, 200},
		{"empty id", `{"Code":0,"Data":{"BaseResponse":{"ret":0},"CountinueFlag":0,"ContactUsernameList":[""]}}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
			if ids, err := client.GetContactList("robot"); err == nil || ids != nil {
				t.Fatalf("incomplete snapshot accepted: ids=%v, err=%v", ids, err)
			}
		})
	}
}

func TestContactListLaterPageFailureDiscardsPartialResults(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		if requests == 1 {
			w.Write([]byte(`{"Code":0,"Data":{"BaseResponse":{"ret":0},"CountinueFlag":1,"CurrentWxcontactSeq":8,"ContactUsernameList":["a"]}}`))
			return
		}
		w.Write([]byte(`{"Code":-13,"Message":"offline"}`))
	}))
	defer server.Close()
	client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
	if ids, err := client.GetContactList("robot"); err == nil || ids != nil || requests != 2 {
		t.Fatalf("partial snapshot accepted: ids=%v requests=%d err=%v", ids, requests, err)
	}
}
