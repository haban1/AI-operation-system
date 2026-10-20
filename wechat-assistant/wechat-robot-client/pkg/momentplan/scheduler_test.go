package momentplan

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/robot"
)

func fixture(t *testing.T) (*Manager, *int64, *atomic.Int32) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { sqlDB.Close() })
	if err = db.AutoMigrate(&model.MomentPlan{}, &model.MomentPlanJob{}, &model.MomentPlanAsset{}, &model.KnowledgeCategory{}); err != nil {
		t.Fatal(err)
	}
	now := int64(1800000000)
	sent := &atomic.Int32{}
	m := New(db)
	m.Now = func() time.Time { return time.Unix(now, 0) }
	m.Online = func() bool { return true }
	m.Generate = func(context.Context, model.MomentPlan) (string, string, error) {
		return "知识库中的真实业务介绍", "业务说明", nil
	}
	m.Upload = func(context.Context, []byte) (robot.FriendCircleUploadResponse, error) {
		return robot.FriendCircleUploadResponse{}, nil
	}
	m.Publish = func(context.Context, model.MomentContent, []robot.FriendCircleUploadResponse) (string, error) {
		sent.Add(1)
		return "12345678901234567890", nil
	}
	return m, &now, sent
}
func request(now int64) CreateRequest {
	return CreateRequest{ID: uuid.NewString(), Name: "测试计划", Kind: "manual", PublishMode: "auto", Repeat: "once", Timezone: "Asia/Shanghai", FirstRunAt: now + 60, Payload: model.MomentContent{Content: "下午好", ShareType: "private"}}
}
func tick(t *testing.T, m *Manager) {
	t.Helper()
	if err := m.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func jobs(t *testing.T, m *Manager) []model.MomentPlanJob {
	t.Helper()
	var j []model.MomentPlanJob
	if err := m.Store.DB.Order("created_at").Find(&j).Error; err != nil {
		t.Fatal(err)
	}
	return j
}

func TestScheduledPostPersistentIdempotentAndExactlyOnceClaim(t *testing.T) {
	m, now, sent := fixture(t)
	r := request(*now)
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	if sent.Load() != 0 {
		t.Fatal("sent before due")
	}
	if len(jobs(t, m)) != 1 {
		t.Fatal("missing durable job")
	}
	*now += 61
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal("lost-response retry must reuse plan", err)
	}
	m2 := New(m.Store.DB)
	m2.Now = m.Now
	m2.Online = m.Online
	m2.Publish = m.Publish
	m2.Upload = m.Upload
	m2.Generate = m.Generate
	var wg sync.WaitGroup
	for _, worker := range []*Manager{m, m2} {
		wg.Add(1)
		go func(w *Manager) {
			defer wg.Done()
			if err := w.Tick(context.Background()); err != nil {
				t.Error(err)
			}
		}(worker)
	}
	wg.Wait()
	tick(t, m2)
	if sent.Load() != 1 || jobs(t, m)[0].Status != "published" {
		t.Fatal("duplicate or lost publish", sent.Load(), jobs(t, m))
	}
	r.Payload.Content = "另一个内容"
	if _, err := m.Store.Create(r, *now); err == nil {
		t.Fatal("id reused for changed payload")
	}
}

func TestReviewMustApproveAndReschedule(t *testing.T) {
	m, now, sent := fixture(t)
	r := request(*now)
	r.Kind = "ai"
	r.Topic = "社区服务"
	r.PublishMode = "review"
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	j := jobs(t, m)[0]
	if j.Status != "awaiting_review" || j.Payload.Content == "" {
		t.Fatal(j)
	}
	*now += 7200
	tick(t, m)
	if sent.Load() != 0 {
		t.Fatal("unreviewed content was sent")
	}
	if err := m.Store.JobAction(JobActionRequest{JobID: j.ID, Action: "approve", Content: "人工修订的正文", ScheduledAt: *now - 1}, *now); err == nil {
		t.Fatal("accepted past approval time")
	}
	if err := m.Store.JobAction(JobActionRequest{JobID: j.ID, Action: "approve", Content: "人工修订的正文", ScheduledAt: *now + 60}, *now); err != nil {
		t.Fatal(err)
	}
	*now += 61
	tick(t, m)
	j = jobs(t, m)[0]
	if sent.Load() != 1 || j.Payload.Content != "人工修订的正文" || j.Sources != "业务说明" {
		t.Fatal(j)
	}
}

func TestCancelledAndPausedPlansNeverSend(t *testing.T) {
	for _, action := range []string{"pause", "cancel"} {
		t.Run(action, func(t *testing.T) {
			m, now, sent := fixture(t)
			r := request(*now)
			r.Kind = "ai"
			r.Topic = "话题"
			r.Repeat = "daily"
			if _, err := m.Store.Create(r, *now); err != nil {
				t.Fatal(err)
			}
			tick(t, m)
			if err := m.Store.PlanAction(r.ID, action, *now); err != nil {
				t.Fatal(err)
			}
			*now += 61
			tick(t, m)
			if sent.Load() != 0 || jobs(t, m)[0].Status != "cancelled" {
				t.Fatal("cancel ignored")
			}
			if action == "pause" {
				if err := m.Store.PlanAction(r.ID, "resume", *now); err != nil {
					t.Fatal(err)
				}
				tick(t, m)
				if sent.Load() != 0 {
					t.Fatal("resume resent cancelled occurrence")
				}
			}
		})
	}
}

func TestLostPublishResponsePausesRecurringPlanWithoutRetry(t *testing.T) {
	m, now, sent := fixture(t)
	r := request(*now)
	r.Kind = "ai"
	r.Topic = "话题"
	r.Repeat = "daily"
	m.Publish = func(context.Context, model.MomentContent, []robot.FriendCircleUploadResponse) (string, error) {
		sent.Add(1)
		return "", errors.New("response lost")
	}
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	*now += 61
	tick(t, m)
	*now += 86400
	tick(t, m)
	var p model.MomentPlan
	m.Store.DB.First(&p, "id = ?", r.ID)
	if sent.Load() != 1 || p.Status != "paused" || jobs(t, m)[0].Status != "uncertain" {
		t.Fatal(p, jobs(t, m), sent.Load())
	}
}

func TestRestartAndOfflineExpiryNeverCatchUp(t *testing.T) {
	m, now, sent := fixture(t)
	r := request(*now)
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	m.Online = func() bool { return false }
	*now += 61
	tick(t, m)
	if jobs(t, m)[0].Status != "scheduled" {
		t.Fatal("offline job lost")
	}
	*now += 3601
	m.Online = func() bool { return true }
	tick(t, m)
	if sent.Load() != 0 || jobs(t, m)[0].Status != "expired" {
		t.Fatal("expired post sent")
	}
	r = request(*now)
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	var j model.MomentPlanJob
	m.Store.DB.First(&j, "plan_id = ?", r.ID)
	m.Store.DB.Model(&j).Updates(map[string]any{"status": "publishing", "updated_at": *now - 1801})
	tick(t, m)
	m.Store.DB.First(&j, "id = ?", j.ID)
	if j.Status != "uncertain" || sent.Load() != 0 {
		t.Fatal("restart retried publishing")
	}
}

func TestGenerationFailureAndCancelDuringGeneration(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{true: "cancel", false: "no_evidence"}[cancel], func(t *testing.T) {
			m, now, sent := fixture(t)
			r := request(*now)
			r.Kind = "ai"
			r.Topic = "业务"
			m.Generate = func(context.Context, model.MomentPlan) (string, string, error) {
				if cancel {
					if err := m.Store.PlanAction(r.ID, "cancel", *now); err != nil {
						t.Fatal(err)
					}
					return "已取消的文案", "", nil
				}
				return "", "", ErrNoEvidence
			}
			if _, err := m.Store.Create(r, *now); err != nil {
				t.Fatal(err)
			}
			tick(t, m)
			*now += 61
			tick(t, m)
			want := "failed"
			if cancel {
				want = "cancelled"
			}
			if jobs(t, m)[0].Status != want || sent.Load() != 0 {
				t.Fatal(jobs(t, m))
			}
		})
	}
}

func TestMediaUploadedAtDueAndCancelDuringUpload(t *testing.T) {
	m, now, sent := fixture(t)
	r := request(*now)
	a := model.MomentPlanAsset{ID: uuid.NewString(), Data: []byte("original bytes"), Size: 14, MediaType: "image", Name: "图.png"}
	if err := m.Store.DB.Create(&a).Error; err != nil {
		t.Fatal(err)
	}
	r.Payload.AssetIDs = []string{a.ID}
	uploads := 0
	m.Upload = func(_ context.Context, data []byte) (robot.FriendCircleUploadResponse, error) {
		uploads++
		if string(data) != "original bytes" {
			t.Fatal("original bytes lost")
		}
		if err := m.Store.PlanAction(r.ID, "cancel", *now); err != nil {
			t.Fatal(err)
		}
		return robot.FriendCircleUploadResponse{}, nil
	}
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	if uploads != 0 {
		t.Fatal("uploaded before due")
	}
	*now += 61
	tick(t, m)
	if uploads != 1 || sent.Load() != 0 || jobs(t, m)[0].Status != "cancelled" {
		t.Fatal("cancel during upload ignored")
	}
}

func TestCalendarRecurrenceAndValidation(t *testing.T) {
	loc, _ := time.LoadLocation("America/New_York")
	at := time.Date(2026, 3, 7, 9, 0, 0, 0, loc)
	next, err := NextOccurrence(at.Unix(), at.Unix(), "daily", loc.String())
	if err != nil {
		t.Fatal(err)
	}
	nt := time.Unix(next, 0).In(loc)
	if nt.Hour() != 9 || nt.Sub(at) != 23*time.Hour {
		t.Fatal(nt)
	}
	m, now, _ := fixture(t)
	r := request(*now)
	r.Payload.ShareType = "share_with"
	if _, err := m.Store.Create(r, *now); err == nil {
		t.Fatal("empty visible list accepted")
	}
	r = request(*now)
	r.FirstRunAt = *now
	if _, err := m.Store.Create(r, *now); err == nil {
		t.Fatal("past time accepted")
	}
	r = request(*now)
	r.Kind = "ai"
	r.Topic = "主题"
	r.KnowledgeCodes = []string{"missing"}
	if _, err := m.Store.Create(r, *now); err == nil {
		t.Fatal("unknown knowledge accepted")
	}
}

func TestResumeSkipsAlreadyMaterializedFutureOccurrence(t *testing.T) {
	m, now, sent := fixture(t)
	r := request(*now)
	r.Kind = "ai"
	r.Topic = "社区"
	r.Repeat = "daily"
	r.PublishMode = "review"
	r.FirstRunAt = *now + 3600
	if _, err := m.Store.Create(r, *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	if err := m.Store.PlanAction(r.ID, "pause", *now); err != nil {
		t.Fatal(err)
	}
	if err := m.Store.PlanAction(r.ID, "resume", *now); err != nil {
		t.Fatal(err)
	}
	tick(t, m)
	*now += 3601
	tick(t, m)
	var p model.MomentPlan
	m.Store.DB.First(&p, "id = ?", r.ID)
	if p.NextRunAt <= r.FirstRunAt || sent.Load() != 0 {
		t.Fatal("resume reused cancelled occurrence", p)
	}
	if jobs(t, m)[0].Status != "cancelled" {
		t.Fatal("cancelled draft changed")
	}
}
