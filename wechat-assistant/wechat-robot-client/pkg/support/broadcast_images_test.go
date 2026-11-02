package support

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"wechat-robot-client/model"
)

func broadcastTestImages() [][]byte {
	return [][]byte{[]byte("GIF89a-first"), []byte("GIF89a-second"), []byte("GIF89a-third")}
}

func TestBroadcastThreeImagesPersistAndSendInOrder(t *testing.T) {
	m := fixture(t)
	images := broadcastTestImages()
	id := "three-images-request"
	for range 2 {
		job, err := m.SubmitImages(id, "hello", []string{"alice", "bob"}, images, true)
		if err != nil || job.ImageCount != 3 {
			t.Fatalf("submit: %+v %v", job, err)
		}
	}
	var count int64
	m.DB.Model(&model.SupportBroadcastImage{}).Count(&count)
	if count != 3 {
		t.Fatalf("duplicate or missing assets: %d", count)
	}
	if _, err := m.SubmitImages(id, "hello", []string{"alice", "bob"}, [][]byte{images[1], images[0], images[2]}, true); err == nil {
		t.Fatal("changed image order reused a request ID")
	}
	sent := []string{}
	m.SendText = func(peer, text string, _ ...string) error { sent = append(sent, peer+":"+text); return nil }
	m.SendImage = func(peer string, image []byte) error { sent = append(sent, peer+":"+string(image)); return nil }
	for range 2 {
		if err := m.RunBroadcast(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"alice:hello", "alice:GIF89a-first", "alice:GIF89a-second", "alice:GIF89a-third", "bob:hello", "bob:GIF89a-first", "bob:GIF89a-second", "bob:GIF89a-third"}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("wrong order or duplicate sends: %v", sent)
	}
	var job model.SupportBroadcast
	m.DB.First(&job, "id = ?", id)
	var results []Delivery
	if err := json.Unmarshal(job.Results, &results); err != nil {
		t.Fatal(err)
	}
	if job.Status != "completed" || job.SuccessCount != 2 || len(results) != 2 || results[0].ImagesSent != 3 || !results[0].ImageSent {
		t.Fatalf("incorrect results: %+v %+v", job, results)
	}
}

func TestBroadcastRejectsInvalidImagesWithoutCreatingJob(t *testing.T) {
	for _, images := range [][][]byte{
		append(broadcastTestImages(), []byte("GIF89a-fourth")),
		{[]byte("GIF89a-ok"), nil},
		{[]byte("GIF89a-ok"), []byte("not an image")},
		{append([]byte("GIF89a"), bytes.Repeat([]byte{0}, MaxBroadcastImageBytes)...)},
	} {
		m := fixture(t)
		if _, err := m.SubmitImages("invalid-image-request", "hello", []string{"alice"}, images, true); err == nil {
			t.Fatal("invalid image accepted")
		}
		var count int64
		m.DB.Model(&model.SupportBroadcast{}).Count(&count)
		if count != 0 {
			t.Fatal("invalid request created a sendable job")
		}
	}
}

func TestBroadcastImageFailureRecordsProgressAndContinuesNextFriend(t *testing.T) {
	m := fixture(t)
	job, err := m.SubmitImages("partial-image-request", "", []string{"alice", "bob"}, broadcastTestImages(), true)
	if err != nil {
		t.Fatal(err)
	}
	sends := 0
	m.SendImage = func(peer string, image []byte) error {
		sends++
		if peer == "alice" && string(image) == "GIF89a-second" {
			return errors.New("unconfirmed")
		}
		return nil
	}
	if err := m.RunBroadcast(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	m.DB.First(&job, "id = ?", job.ID)
	var results []Delivery
	_ = json.Unmarshal(job.Results, &results)
	if sends != 5 || job.Status != "partial" || job.SuccessCount != 1 || job.FailedCount != 1 || results[0].ImagesSent != 1 || results[0].ImageSent || !strings.Contains(results[0].Error, "第 2/3 张") || results[1].ImagesSent != 3 {
		t.Fatalf("bad partial result: sends=%d results=%+v", sends, results)
	}
}

func TestBroadcastCancellationBetweenImagesNeverReplays(t *testing.T) {
	m := fixture(t)
	job, err := m.SubmitImages("cancel-image-request", "", []string{"alice"}, broadcastTestImages(), true)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sends := 0
	m.SendImage = func(string, []byte) error { sends++; cancel(); return nil }
	if err := m.RunBroadcast(ctx, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.RunBroadcast(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	m.DB.First(&job, "id = ?", job.ID)
	var results []Delivery
	_ = json.Unmarshal(job.Results, &results)
	if sends != 1 || job.Status != "interrupted" || results[0].ImagesSent != 1 {
		t.Fatal("canceled task lost progress or replayed")
	}
}

func TestBroadcastLegacySingleImageStillSends(t *testing.T) {
	m := fixture(t)
	job := model.SupportBroadcast{ID: "legacy-image-request", HasImage: true, Image: []byte("GIF89a-legacy"), Recipients: []byte(`["alice"]`), Status: "pending", Results: []byte(`[]`)}
	if err := m.DB.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	sends := 0
	m.SendImage = func(_ string, image []byte) error {
		sends++
		if string(image) != "GIF89a-legacy" {
			t.Error("legacy bytes changed")
		}
		return nil
	}
	if err := m.RunBroadcast(context.Background(), job.ID); err != nil {
		t.Fatal(err)
	}
	if sends != 1 {
		t.Fatal("legacy image was skipped")
	}
}

func TestBroadcastAssetFailureRollsBackWholeJob(t *testing.T) {
	m := fixture(t)
	if err := m.DB.Exec(`CREATE TRIGGER reject_second_image BEFORE INSERT ON support_broadcast_images WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'storage full'); END`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := m.SubmitImages("atomic-image-request", "", []string{"alice"}, broadcastTestImages(), true); err == nil {
		t.Fatal("partial storage accepted")
	}
	for _, table := range []string{"support_broadcasts", "support_broadcast_images"} {
		var count int64
		m.DB.Table(table).Count(&count)
		if count != 0 {
			t.Fatalf("orphaned data in %s", table)
		}
	}
}
