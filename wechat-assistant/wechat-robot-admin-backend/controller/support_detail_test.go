package controller

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"wechat-robot-admin-backend/model"
)

func TestBroadcastDetailProxy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != "GET" || r.URL.Query().Get("broadcast_id") != "detail-job-123456" || r.URL.Query().Has("id") || r.URL.Query().Has("api_token") || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
			t.Error("wrong task or credentials forwarded")
		}
		switch r.URL.Path {
		case "/support/broadcasts/detail":
			if len(r.URL.Query()) != 1 {
				t.Error("unexpected detail parameters")
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"code":200,"data":{"job":{"id":"detail-job-123456"}}}`))
		case "/support/broadcasts/image":
			if r.URL.Query().Get("position") != "2" || len(r.URL.Query()) != 2 {
				t.Error("image position lost")
			}
			w.Header().Set("Content-Type", "image/png")
			w.Header().Set("Cache-Control", "private, no-store")
			w.Write([]byte("image-bytes"))
		default:
			t.Error("unexpected upstream route")
		}
	}))
	defer upstream.Close()
	t.Setenv("DEV_ROBOT_CLIENT_URL", upstream.URL)
	for _, endpoint := range []string{"detail", "image"} {
		path := "/api/v1/support/broadcasts/" + endpoint
		router := gin.New()
		router.GET(path, func(c *gin.Context) { c.Set("robot", &model.Robot{ID: 3}); SupportProxy(c) })
		req := httptest.NewRequest("GET", path+"?id=3&broadcast_id=detail-job-123456&position=2&api_token=private", nil)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		req = req.WithContext(ctx)
		req.Header.Set("Cookie", "private=cookie")
		req.Header.Set("Authorization", "Bearer private")
		result := httptest.NewRecorder()
		router.ServeHTTP(result, req)
		if result.Code != 200 {
			t.Fatal("proxy failed", result.Code)
		}
		if endpoint == "image" && (result.Body.String() != "image-bytes" || result.Header().Get("Content-Type") != "image/png" || result.Header().Get("Cache-Control") != "private, no-store") {
			t.Fatal("image response changed")
		}
	}
	router := gin.New()
	router.GET("/api/v1/support/broadcasts/detail", SupportProxy)
	router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/v1/support/broadcasts/detail?id=3", nil))
	if requests != 2 {
		t.Fatal("request without authorized robot reached upstream")
	}
}
