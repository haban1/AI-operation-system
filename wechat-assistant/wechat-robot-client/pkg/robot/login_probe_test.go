package robot

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLoginProbeValidatesResponse(t *testing.T) {
	for _, tt := range []struct {
		name, body string
		status     int
		ok         bool
	}{
		{"valid", `{"Success":true,"Code":0,"Data":{"baseResponse":{"ret":0},"userInfo":{"UserName":{"string":"test-account"}}}}`, 200, true},
		{"empty", `{}`, 200, false},
		{"missing username", `{"Success":true,"Data":{"userInfo":{}}}`, 200, false},
		{"different account", `{"Success":true,"Data":{"userInfo":{"UserName":{"string":"other"}}}}`, 200, false},
		{"expired", `{"Success":false,"Code":-13,"Message":"expired"}`, 200, false},
		{"base response error", `{"Success":true,"Data":{"baseResponse":{"ret":-13},"userInfo":{"UserName":{"string":"test-account"}}}}`, 200, false},
		{"proxy error", `{}`, 502, false},
		{"unknown code", `{"Code":-999,"Data":{"userInfo":{"UserName":{"string":"test-account"}}}}`, 200, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api"+UserGetContactProfile || r.URL.Query().Get("wxid") != "test-account" {
					t.Error("wrong probe request")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
			_, err := client.GetProfileContext(context.Background(), "test-account")
			if (err == nil) != tt.ok {
				t.Fatalf("probe error = %v, want success=%v", err, tt.ok)
			}
		})
	}
}

func TestLoginProbeHonorsCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	client := NewClient(WechatDomain(strings.TrimPrefix(server.URL, "http://")), ProxyInfo{})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := client.GetProfileContext(ctx, "test-account"); err == nil {
		t.Fatal("expected timeout")
	}
}
