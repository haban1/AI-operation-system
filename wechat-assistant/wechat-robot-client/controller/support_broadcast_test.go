package controller

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/support"
)

func TestBroadcastMultipartLimitsAndCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fields []string
		size   int
		ok     bool
	}{
		{"three at size limit", []string{"image", "image2", "image3"}, support.MaxBroadcastImageBytes, true},
		{"legacy single image", []string{"image"}, 20, true},
		{"four images", []string{"image", "image2", "image3", "image3"}, 20, false},
		{"oversized image", []string{"image"}, support.MaxBroadcastImageBytes + 1, false},
		{"unknown image field", []string{"extra_image"}, 20, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
			if err != nil {
				t.Fatal(err)
			}
			conn, _ := db.DB()
			conn.SetMaxOpenConns(1)
			defer conn.Close()
			if err := db.AutoMigrate(&model.SupportBroadcast{}, &model.SupportBroadcastImage{}); err != nil {
				t.Fatal(err)
			}
			db.Exec("CREATE TABLE contacts (wechat_id TEXT, type TEXT, status INTEGER, deleted_at DATETIME)")
			db.Exec("INSERT INTO contacts VALUES ('alice','friend',0,NULL)")
			old := support.Default
			support.Default = support.New(db)
			defer func() { support.Default = old }()
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			_ = writer.WriteField("client_request_id", "multipart-test-request")
			_ = writer.WriteField("recipients", `["alice"]`)
			_ = writer.WriteField("confirm_send", "true")
			image := make([]byte, tc.size)
			copy(image, []byte("GIF89a"))
			for _, field := range tc.fields {
				part, err := writer.CreateFormFile(field, "test.gif")
				if err != nil {
					t.Fatal(err)
				}
				_, _ = part.Write(image)
			}
			_ = writer.Close()
			req := httptest.NewRequest("POST", "/broadcasts", &body)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			router := gin.New()
			router.POST("/broadcasts", (&Support{}).Broadcast)
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			var result struct {
				Code    int                    `json:"code"`
				Message string                 `json:"message"`
				Data    model.SupportBroadcast `json:"data"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if (result.Code == 200) != tc.ok {
				t.Fatalf("unexpected response: %s", recorder.Body)
			}
			var count int64
			db.Model(&model.SupportBroadcast{}).Count(&count)
			if tc.ok && (result.Data.ImageCount != len(tc.fields) || count != 1) {
				t.Fatal("upload did not persist every image")
			}
			if !tc.ok && count != 0 {
				t.Fatal("invalid upload queued a broadcast")
			}
		})
	}
}
