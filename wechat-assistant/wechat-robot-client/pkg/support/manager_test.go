package support

import (
	"context"
	"errors"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"sync"
	"testing"
	"time"
	"wechat-robot-client/model"
)

func fixture(t *testing.T) *Manager {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err = db.AutoMigrate(&model.SupportReception{}, &model.SupportSettings{}, &model.SupportBroadcast{}); err != nil {
		t.Fatal(err)
	}
	db.Exec("CREATE TABLE contacts (wechat_id TEXT, type TEXT, status INTEGER, deleted_at DATETIME)")
	db.Exec("INSERT INTO contacts(wechat_id,type,status) VALUES ('alice','friend',0),('bob','friend',0)")
	m := New(db)
	m.Interval = 0
	m.SendText = func(string, string, ...string) error { return nil }
	m.SendImage = func(string, []byte) error { return nil }
	return m
}

func TestStaleHandoffCannotRetakeResumedConversation(t *testing.T) {
	m := fixture(t)
	version, _ := m.Begin("alice", "")
	changed, err := m.TakeoverForTurn("alice", "", "requested", version)
	if err != nil || !changed {
		t.Fatal("first takeover failed", err)
	}
	if changed, err = m.TakeoverForTurn("alice", "", "duplicate", version); err != nil || changed {
		t.Fatal("duplicate takeover accepted", err)
	}
	m.Transition("alice", "", false, "")
	if changed, err = m.TakeoverForTurn("alice", "", "stale", version); err != nil || changed {
		t.Fatal("stale takeover accepted after resume", err)
	}
	if _, allowed := m.Begin("alice", ""); !allowed {
		t.Fatal("resumed conversation was taken over again")
	}
}

func TestTakeoverBlocksLateAnswerAndResumeDoesNotReviveIt(t *testing.T) {
	m := fixture(t)
	version, ok := m.Begin("alice", "")
	if !ok {
		t.Fatal("initial answer blocked")
	}
	if err := m.Takeover("alice", "", "requested"); err != nil {
		t.Fatal(err)
	}
	if unlock, ok := m.Permit("alice", "", version); ok {
		unlock()
		t.Fatal("late answer allowed")
	}
	m.Transition("alice", "", false, "")
	if unlock, ok := m.Permit("alice", "", version); ok {
		unlock()
		t.Fatal("old answer revived")
	}
	fresh, ok := m.Begin("alice", "")
	if !ok {
		t.Fatal("new answer blocked")
	}
	unlock, ok := m.Permit("alice", "", fresh)
	if !ok {
		t.Fatal("new answer denied")
	}
	unlock()
}

func TestNotificationFailureKeepsReceptionAndDoesNotRepeat(t *testing.T) {
	m := fixture(t)
	m.DB.Create(&model.SupportSettings{ID: 1, Notifier: "bob", KnowledgeCodes: []byte("[]")})
	sends := 0
	m.SendText = func(string, string, ...string) error { sends++; return errors.New("offline") }
	for range 2 {
		if err := m.Takeover("alice", "", "requested"); err != nil {
			t.Fatal(err)
		}
	}
	r, err := m.state("alice", "")
	if err != nil || !r.Active || r.NotificationError == "" || sends != 1 {
		t.Fatalf("state=%+v sends=%d err=%v", r, sends, err)
	}
	if _, ok := m.Begin("bob", ""); !ok {
		t.Fatal("other friend blocked")
	}
	if _, ok := m.Begin("alice", "group@chatroom"); !ok {
		t.Fatal("other conversation blocked")
	}
}

func TestTakeoverWaitsForAlreadyStartedSend(t *testing.T) {
	m := fixture(t)
	v, _ := m.Begin("alice", "")
	unlock, ok := m.Permit("alice", "", v)
	if !ok {
		t.Fatal("permit")
	}
	started := make(chan struct{})
	done := make(chan struct{})
	go func() { close(started); m.Transition("alice", "", true, ""); close(done) }()
	<-started
	select {
	case <-done:
		t.Fatal("transition bypassed active send")
	case <-time.After(20 * time.Millisecond):
	}
	unlock()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("transition did not finish")
	}
}

func TestBroadcastIdempotencyAndPartialDelivery(t *testing.T) {
	m := fixture(t)
	id := "request-1234567890"
	sends := []string{}
	m.SendText = func(peer, text string, at ...string) error {
		sends = append(sends, peer)
		if peer == "bob" {
			return errors.New("timeout")
		}
		return nil
	}
	for range 2 {
		if _, err := m.Submit(id, "hello", []string{"alice", "bob"}, nil, true); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Submit(id, "changed", []string{"alice"}, nil, true); err == nil {
		t.Fatal("request reused with different content")
	}
	if err := m.RunBroadcast(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if err := m.RunBroadcast(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	var job model.SupportBroadcast
	m.DB.First(&job, "id = ?", id)
	if len(sends) != 2 || job.SuccessCount != 1 || job.FailedCount != 1 || job.Status != "partial" {
		t.Fatalf("job=%+v sends=%v", job, sends)
	}
}

func TestBroadcastValidationAndConcurrentSubmission(t *testing.T) {
	m := fixture(t)
	for _, tc := range []struct {
		ids     []string
		confirm bool
		image   []byte
	}{{[]string{"alice"}, false, nil}, {[]string{"stranger"}, true, nil}, {[]string{"alice"}, true, []byte("not-an-image")}} {
		if _, err := m.Submit("request-validation", "text", tc.ids, tc.image, tc.confirm); err == nil {
			t.Fatal("invalid task accepted")
		}
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.Submit("request-concurrent", "text", []string{"alice"}, nil, true); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var count int64
	m.DB.Model(&model.SupportBroadcast{}).Count(&count)
	if count != 1 {
		t.Fatalf("duplicate jobs: %d", count)
	}
}

func TestRestartNeverReplaysUncertainTask(t *testing.T) {
	m := fixture(t)
	job, err := m.Submit("request-interrupted", "text", []string{"alice"}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	m.DB.Model(&job).Update("status", "running")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	m.DB.First(&job, "id = ?", job.ID)
	if job.Status != "interrupted" {
		t.Fatal(job.Status)
	}
	called := false
	m.SendText = func(string, string, ...string) error { called = true; return nil }
	m.RunBroadcast(context.Background(), job.ID)
	if called {
		t.Fatal("uncertain delivery replayed")
	}
}
