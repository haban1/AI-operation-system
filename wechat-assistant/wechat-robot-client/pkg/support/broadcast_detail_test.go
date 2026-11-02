package support

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"

	"gorm.io/gorm"
	"wechat-robot-client/model"
)

func TestBroadcastDetailReadOnlyAndImages(t *testing.T) {
	m := fixture(t)
	for _, column := range []string{"nickname", "remark", "avatar"} {
		if err := m.DB.Exec("ALTER TABLE contacts ADD COLUMN " + column + " TEXT").Error; err != nil {
			t.Fatal(err)
		}
	}
	m.DB.Exec("UPDATE contacts SET nickname='客户甲',remark='老客户',avatar='avatar.png' WHERE wechat_id='alice'")
	job, err := m.SubmitImages("detail-three-images", "saved text", []string{"alice", "bob"}, broadcastTestImages(), true)
	if err != nil {
		t.Fatal(err)
	}
	// Retained contacts must still resolve after deletion.
	m.DB.Exec("UPDATE contacts SET deleted_at=CURRENT_TIMESTAMP,status=-10001 WHERE wechat_id='alice'")
	m.SendText = func(string, string, ...string) error { t.Fatal("viewing details sent text"); return nil }
	m.SendImage = func(string, []byte) error { t.Fatal("viewing details sent image"); return nil }
	for range 2 {
		detail, err := m.BroadcastDetails(job.ID)
		if err != nil {
			t.Fatal(err)
		}
		if detail.Job.Status != "pending" || detail.Job.Content != "saved text" || len(detail.Job.Image) != 0 || len(detail.Friends) != 2 || detail.Friends[0].Nickname != "客户甲" {
			t.Fatalf("incorrect detail: %+v", detail)
		}
		encoded, _ := json.Marshal(detail)
		if bytes.Contains(encoded, []byte("GIF89a")) || bytes.Contains(encoded, []byte(job.Fingerprint)) {
			t.Fatal("detail exposed image bytes or fingerprint")
		}
		for index, want := range broadcastTestImages() {
			got, mime, err := m.BroadcastImage(job.ID, index+1)
			if err != nil || mime != "image/gif" || !bytes.Equal(got, want) {
				t.Fatalf("image %d differs: %s %v", index+1, mime, err)
			}
		}
	}
	var saved model.SupportBroadcast
	m.DB.First(&saved, "id = ?", job.ID)
	if saved.Status != job.Status || saved.UpdatedAt != job.UpdatedAt || string(saved.Results) != string(job.Results) {
		t.Fatal("read changed job")
	}
	if _, err := m.BroadcastDetails("missing"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("missing task accepted")
	}
	for _, position := range []int{0, 4} {
		if _, _, err := m.BroadcastImage(job.ID, position); err == nil {
			t.Fatal("invalid image position accepted")
		}
	}
	if _, _, err := m.BroadcastImage("missing", 1); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("image from another task returned")
	}
}

func TestBroadcastDetailLegacyAndMissingImages(t *testing.T) {
	m := fixture(t)
	jobs := []model.SupportBroadcast{
		{ID: "legacy-image-task", HasImage: true, Image: []byte("GIF89a-legacy"), ImageType: "incorrect/type"},
		{ID: "text-only-task", Content: "text"},
		{ID: "missing-image-task", HasImage: true, ImageCount: 2},
		{ID: "invalid-image-task", HasImage: true, Image: []byte("<script>bad</script>")},
	}
	for _, job := range jobs {
		if err := m.DB.Create(&job).Error; err != nil {
			t.Fatal(err)
		}
	}
	image, mime, err := m.BroadcastImage(jobs[0].ID, 1)
	if err != nil || string(image) != "GIF89a-legacy" || mime != "image/gif" {
		t.Fatal("legacy image unavailable", err)
	}
	for _, id := range []string{jobs[1].ID, jobs[2].ID, jobs[3].ID} {
		if _, _, err := m.BroadcastImage(id, 1); err == nil {
			t.Fatal("invalid or missing image accepted")
		}
	}
	if _, _, err := m.BroadcastImage(jobs[0].ID, 2); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("legacy task gained second image")
	}
}
