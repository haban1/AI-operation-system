package controller

import (
	"bytes"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"wechat-robot-admin-backend/dto"
	"wechat-robot-admin-backend/model"
)

func TestConversationImageSend(t *testing.T) {
	gin.SetMode(gin.TestMode)
	status, reply, requests := 200, `{"code":200}`, 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != "POST" || r.URL.Path != "/message/send/image" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		f, header, err := r.FormFile("image")
		if err != nil {
			t.Error(err)
			return
		}
		defer f.Close()
		defer r.MultipartForm.RemoveAll()
		data, _ := io.ReadAll(f)
		if string(data) != "test-image-bytes" || header.Filename != "test.png" || r.FormValue("to_wxid") != "test-recipient" {
			t.Error("recipient or image changed")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(reply))
	}))
	defer upstream.Close()
	t.Setenv("DEV_ROBOT_CLIENT_URL", upstream.URL)
	router := gin.New()
	router.POST("/image", func(c *gin.Context) { c.Set("robot", &model.Robot{ID: 3}); NewMessageController().SendImageMessage(c) })
	for _, tc := range []struct {
		name   string
		status int
		reply  string
		ok     bool
	}{
		{"success", 200, `{"code":200}`, true},
		{"offline", 200, `{"code":500,"message":"robot offline"}`, false},
		{"http-error", 502, `bad gateway`, false},
		{"invalid-response", 200, `{}`, false},
		{"broken-json", 200, `invalid`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, reply = tc.status, tc.reply
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			writer.WriteField("to_wxid", "test-recipient")
			part, _ := writer.CreateFormFile("image", "test.png")
			part.Write([]byte("test-image-bytes"))
			writer.Close()
			// Match the generated API: robot ID in query, image/recipient in form.
			req := httptest.NewRequest("POST", "/image?id=3", &body)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			resp := httptest.NewRecorder()
			before := requests
			router.ServeHTTP(resp, req)
			var result dto.Response[any]
			if err := json.Unmarshal(resp.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if (result.Code == 200) != tc.ok {
				t.Fatalf("incorrect delivery outcome: %s", resp.Body.String())
			}
			if requests != before+1 {
				t.Fatalf("expected exactly one send, got %d", requests-before)
			}
		})
	}
}
