package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
	"wechat-robot-client/dto"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/robot"
	"wechat-robot-client/repository"
	"wechat-robot-client/utils"
	"wechat-robot-client/vars"
)

func TestChatImageHistory(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	if err = db.AutoMigrate(&model.Message{}, &model.MessageImage{}, &model.MessageImageChunk{}); err != nil {
		t.Fatal(err)
	}
	type testContact struct {
		model.Contact
		ID   int64             `gorm:"primaryKey;type:integer;autoIncrement"`
		Type model.ContactType `gorm:"type:text"`
	}
	if err = db.Table("contacts").AutoMigrate(&testContact{}); err != nil {
		t.Fatal(err)
	}
	oldDB, oldRobot := vars.DB, vars.RobotRuntime
	t.Cleanup(func() { vars.DB, vars.RobotRuntime = oldDB, oldRobot })
	vars.DB = db
	var buf bytes.Buffer
	if err = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()
	sends, downloads, streamCalls := 0, 0, 0
	invalidDownload := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, robot.MsgUploadImg):
			sends++
			var req robot.MsgUploadImgRequest
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				t.Error(err)
			}
			decoded, _ := base64.StdEncoding.DecodeString(req.Base64)
			if !bytes.Equal(decoded, data) {
				t.Error("sent bytes changed")
			}
			json.NewEncoder(w).Encode(robot.ClientResponse[robot.MsgUploadImgResponse]{Code: 0, Success: true, Data: robot.MsgUploadImgResponse{Newmsgid: int64(100 + sends), Msgid: int64(100 + sends), CreateTime: time.Now().Unix()}})
		case strings.HasSuffix(r.URL.Path, robot.SendImageMessageStream):
			streamCalls++
			if err := r.ParseMultipartForm(1024 * 1024); err != nil {
				t.Error(err)
			}
			defer r.MultipartForm.RemoveAll()
			f, _, err := r.FormFile("chunk")
			if err != nil {
				t.Error(err)
				return
			}
			chunk, _ := io.ReadAll(f)
			f.Close()
			offset, _ := strconv.ParseInt(r.FormValue("StartPos"), 10, 64)
			total, _ := strconv.ParseInt(r.FormValue("TotalLen"), 10, 64)
			result := robot.MsgUploadImgResponse{}
			if offset+int64(len(chunk)) == total {
				result.Newmsgid = 200
				result.Msgid = 200
				result.CreateTime = time.Now().Unix()
			}
			json.NewEncoder(w).Encode(robot.ClientResponse[robot.MsgUploadImgResponse]{Code: 0, Success: true, Data: result})
		case strings.HasSuffix(r.URL.Path, robot.ToolsCdnDownloadImage):
			downloads++
			img := data
			if invalidDownload {
				img = []byte("not an image")
			}
			json.NewEncoder(w).Encode(robot.ClientResponse[robot.DownloadImageDetail]{Code: 0, Success: true, Data: robot.DownloadImageDetail{Image: base64.StdEncoding.EncodeToString(img)}})
		default:
			t.Errorf("unexpected external call: %s", r.URL.Path)
			w.WriteHeader(500)
		}
	}))
	defer server.Close()
	vars.RobotRuntime = &robot.Robot{WxID: "self", Client: robot.NewClient(robot.WechatDomain(strings.TrimPrefix(server.URL, "http://")), robot.ProxyInfo{})}
	svc := NewMessageService(context.Background())
	download := NewAttachDownloadService(context.Background())
	checkImage := func(id int64) {
		t.Helper()
		got, mime, ext, err := download.DownloadImage(id)
		if err != nil || !bytes.Equal(got, data) || mime != "image/png" || ext != ".png" {
			t.Fatalf("preview mismatch: mime=%s ext=%s err=%v", mime, ext, err)
		}
	}
	m, err := svc.MsgUploadImg("friend", bytes.NewReader(data))
	if err != nil || m == nil || m.ID == 0 {
		t.Fatalf("send: %v", err)
	}
	checkImage(m.ID)
	if sends != 1 || downloads != 0 {
		t.Fatal("outgoing preview repeated delivery or used CDN")
	}
	content := `<msg><img aeskey="key" cdnmidimgurl="file"/></msg>`
	svc.ProcessMessage(robot.SyncMessage{AddMsgs: []robot.Message{{NewMsgId: m.MsgId, MsgType: model.MsgTypeImage, FromUserName: robot.SKBuiltinStringT{String: utils.StringPtr("self")}, ToUserName: robot.SKBuiltinStringT{String: utils.StringPtr("friend")}, Content: robot.SKBuiltinStringT{String: &content}, CreateTime: time.Now().Unix()}}})
	var count int64
	db.Model(&model.Message{}).Count(&count)
	var enriched model.Message
	db.First(&enriched, m.ID)
	if count != 1 || enriched.Content != content {
		t.Fatal("echo did not enrich exactly one existing record")
	}
	incoming := model.Message{MsgId: 300, Type: model.MsgTypeImage, Content: content, FromWxID: "friend", SenderWxID: "friend"}
	if err = db.Create(&incoming).Error; err != nil {
		t.Fatal(err)
	}
	checkImage(incoming.ID)
	checkImage(incoming.ID)
	if downloads != 1 {
		t.Fatal("incoming image not retained after first preview")
	}
	missing := model.Message{Type: model.MsgTypeImage}
	db.Create(&missing)
	if _, _, _, err = download.DownloadImage(missing.ID); err == nil || strings.Contains(err.Error(), "EOF") {
		t.Fatal("missing image did not return useful error")
	}
	invalid := model.Message{Type: model.MsgTypeImage, Content: content}
	db.Create(&invalid)
	invalidDownload = true
	if _, _, _, err = download.DownloadImage(invalid.ID); err == nil {
		t.Fatal("invalid CDN bytes accepted")
	}
	if cached, _ := svc.msgRepo.GetImage(invalid.ID); len(cached) > 0 {
		t.Fatal("invalid bytes cached")
	}
	// Multipart sends retain all chunks; viewing cannot require another protocol send.
	large := append(append([]byte{}, data...), make([]byte, vars.UploadImageChunkSize)...)
	for offset := int64(0); offset < int64(len(large)); offset += vars.UploadImageChunkSize {
		end := min(offset+vars.UploadImageChunkSize, int64(len(large)))
		message, err := svc.SendImageMessageStream(context.Background(), dto.SendImageMessageRequest{ToWxid: "friend", ClientImgId: "upload-1", FileSize: int64(len(large)), ChunkIndex: offset / vars.UploadImageChunkSize, TotalChunks: 2}, bytes.NewReader(large[offset:end]), &multipart.FileHeader{Filename: "test.png"})
		if err != nil {
			t.Fatal(err)
		}
		if end < int64(len(large)) && message != nil {
			t.Fatal("incomplete image recorded")
		}
		if end == int64(len(large)) {
			if message == nil {
				t.Fatal("completed image missing")
			}
			got, _, _, err := download.DownloadImage(message.ID)
			if err != nil || !bytes.Equal(got, large) {
				t.Fatal("streamed image not preserved", err)
			}
		}
	}
	if streamCalls != 2 {
		t.Fatal("unexpected multipart resend")
	}
	db.Model(&model.MessageImageChunk{}).Count(&count)
	if count != 0 {
		t.Fatal("completed upload chunks retained")
	}
	// Missing/out-of-order chunks must never be rendered as another image.
	repo := repository.NewMessageRepo(context.Background(), db)
	if err = repo.SaveImageChunk("incomplete", 4, 8, []byte("tail")); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.AssembleImageChunks("incomplete", 8); err == nil {
		t.Fatal("incomplete upload accepted")
	}
	if err = repo.SaveImageChunk("incomplete", 0, 8, []byte("head")); err != nil {
		t.Fatal(err)
	}
	got, err := repo.AssembleImageChunks("incomplete", 8)
	if err != nil || string(got) != "headtail" {
		t.Fatal("chunk order incorrect", err)
	}
	// Once WeChat accepted a send, storage failure must not report delivery failure.
	db.Migrator().DropTable(&model.MessageImage{})
	m, err = svc.MsgUploadImg("friend", bytes.NewReader(data))
	if err != nil || m == nil || sends != 2 {
		t.Fatal("storage failure changed successful send result", err)
	}
}

func TestChatImageShortRIFF(t *testing.T) {
	r := &robot.Robot{}
	for size := 8; size < 12; size++ {
		b := append([]byte("RIFF"), make([]byte, size-4)...)
		_, ext := r.DetectImageType(b)
		if ext != "" {
			t.Fatal("truncated RIFF accepted")
		}
	}
}
