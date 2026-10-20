package momentplan

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/robot"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Manager owns a durable outbox. A publishing job is never automatically retried.
type Manager struct {
	Store    *Store
	Generate func(context.Context, model.MomentPlan) (string, string, error)
	Upload   func(context.Context, []byte) (robot.FriendCircleUploadResponse, error)
	Publish  func(context.Context, model.MomentContent, []robot.FriendCircleUploadResponse) (string, error)
	Online   func() bool
	Now      func() time.Time
	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{}
}

var Default *Manager

func New(db *gorm.DB) *Manager  { return &Manager{Store: &Store{DB: db}, Now: time.Now} }
func (m *Manager) Name() string { return "朋友圈发布计划" }
func (m *Manager) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.done = make(chan struct{})
	go func() {
		defer close(m.done)
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			if err := m.Tick(ctx); err != nil {
				log.Printf("[moment-plans] 调度失败: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
func (m *Manager) Shutdown(ctx context.Context) error {
	if m.cancel == nil {
		return nil
	}
	m.cancel()
	select {
	case <-m.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) Tick(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	now := m.Now().Unix()
	if err := m.recoverStale(now); err != nil {
		return err
	}
	var plans []model.MomentPlan
	if err := m.Store.DB.Where("status = ? AND next_run_at > 0 AND (next_run_at <= ? OR first_run_at = next_run_at OR (publish_mode = ? AND next_run_at <= ?))", "active", now+1800, "review", now+86400).Order("next_run_at").Limit(20).Find(&plans).Error; err != nil {
		return err
	}
	for _, p := range plans {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := m.materialize(p.ID, now); err != nil {
			return err
		}
	}
	var jobs []model.MomentPlanJob
	if err := m.Store.DB.Where("status = ?", "generating").Order("created_at").Limit(10).Find(&jobs).Error; err != nil {
		return err
	}
	for _, j := range jobs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := m.deliverDue(ctx); err != nil {
			return err
		}
		if err := m.generate(ctx, j.ID); err != nil {
			return err
		}
	}
	return m.deliverDue(ctx)
}

func (m *Manager) deliverDue(ctx context.Context) error {
	var jobs []model.MomentPlanJob
	if err := m.Store.DB.Where("status = ? AND scheduled_at <= ?", "scheduled", m.Now().Unix()).Order("scheduled_at").Limit(10).Find(&jobs).Error; err != nil {
		return err
	}
	for _, j := range jobs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := m.deliver(ctx, j.ID); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) materialize(id string, now int64) error {
	return m.Store.DB.Transaction(func(tx *gorm.DB) error {
		p, err := lockPlan(tx, id)
		if err != nil {
			return err
		}
		if p.Status != "active" || p.NextRunAt == 0 {
			return nil
		}
		lookahead := int64(1800)
		if p.PublishMode == "review" {
			lookahead = 86400
		}
		if p.NextRunAt > now+lookahead && p.FirstRunAt != p.NextRunAt {
			return nil
		}
		at := p.NextRunAt
		// Skip old occurrences after downtime, never catch up by sending a burst.
		if at < now-3600 {
			j := model.MomentPlanJob{ID: uuid.NewString(), PlanID: p.ID, PlanName: p.Name, OccurrenceAt: at, ScheduledAt: at, Status: "expired", Payload: p.Payload, Error: "服务恢复时已超过发布时间1小时，未补发", CreatedAt: now, UpdatedAt: now}
			if err = tx.Create(&j).Error; err != nil {
				return err
			}
		} else {
			status := "scheduled"
			if p.Kind == "ai" {
				status = "generating"
			}
			j := model.MomentPlanJob{ID: uuid.NewString(), PlanID: p.ID, PlanName: p.Name, OccurrenceAt: at, ScheduledAt: at, Status: status, Payload: p.Payload, CreatedAt: now, UpdatedAt: now}
			if err = tx.Create(&j).Error; err != nil {
				return err
			}
		}
		after := now
		if at > after {
			after = at
		}
		next, err := NextOccurrence(at, after, p.Repeat, p.Timezone)
		if err != nil {
			return err
		}
		status := "active"
		if next == 0 {
			status = "completed"
		}
		return tx.Model(&p).Updates(map[string]any{"next_run_at": next, "status": status, "updated_at": now}).Error
	})
}

func (m *Manager) transition(id, from, to string, fields map[string]any) (bool, error) {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["status"] = to
	fields["updated_at"] = m.Now().Unix()
	r := m.Store.DB.Model(&model.MomentPlanJob{}).Where("id = ? AND status = ?", id, from).Updates(fields)
	return r.RowsAffected == 1, r.Error
}

func (m *Manager) generate(ctx context.Context, id string) error {
	// Separate claimed state prevents two workers from generating/overwriting the same draft.
	ok, err := m.transition(id, "generating", "drafting", nil)
	if err != nil || !ok {
		return err
	}
	var j model.MomentPlanJob
	if err = m.Store.DB.First(&j, "id = ?", id).Error; err != nil {
		return err
	}
	var p model.MomentPlan
	if err = m.Store.DB.First(&p, "id = ?", j.PlanID).Error; err != nil {
		return err
	}
	genCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	content, sources, genErr := m.Generate(genCtx, p)
	if genErr == nil {
		j.Payload.Content = content
		genErr = validateContent(j.Payload, false)
	}
	if genErr != nil {
		_, err = m.transition(id, "drafting", "failed", map[string]any{"error": fmt.Sprintf("文案生成失败：%s", genErr)})
		return err
	}
	// Use the model serializer by saving the payload with an explicit conditional update.
	status := "scheduled"
	if p.PublishMode == "review" {
		status = "awaiting_review"
	}
	j.Status = status
	j.Sources = sources
	j.UpdatedAt = m.Now().Unix()
	return m.Store.DB.Model(&model.MomentPlanJob{}).Where("id = ? AND status = ?", id, "drafting").Select("payload", "sources", "status", "updated_at").Updates(&j).Error
}

func (m *Manager) claimDelivery(id string) (model.MomentPlanJob, bool, error) {
	var j model.MomentPlanJob
	if err := m.Store.DB.First(&j, "id = ?", id).Error; err != nil {
		return j, false, err
	}
	claimed := false
	err := m.Store.DB.Transaction(func(tx *gorm.DB) error {
		p, err := lockPlan(tx, j.PlanID)
		if err != nil {
			return err
		}
		if p.Status == "paused" || p.Status == "cancelled" {
			return nil
		}
		if err = tx.First(&j, "id = ?", id).Error; err != nil {
			return err
		}
		if j.Status != "scheduled" || j.ScheduledAt > m.Now().Unix() {
			return nil
		}
		status := "uploading"
		reason := ""
		if j.ScheduledAt < m.Now().Unix()-3600 {
			status = "expired"
			reason = "超过发布时间1小时，未自动补发"
		}
		if status == "uploading" && !m.Online() {
			return nil
		}
		r := tx.Model(&j).Where("status = ?", "scheduled").Updates(map[string]any{"status": status, "error": reason, "updated_at": m.Now().Unix()})
		claimed = r.RowsAffected == 1 && status == "uploading"
		return r.Error
	})
	return j, claimed, err
}

func (m *Manager) deliver(ctx context.Context, id string) error {
	j, ok, err := m.claimDelivery(id)
	if err != nil || !ok {
		return err
	}
	assets, err := m.Store.Assets(j.Payload.AssetIDs)
	media := []robot.FriendCircleUploadResponse{}
	if err == nil {
		for _, a := range assets {
			if ctx.Err() != nil {
				err = ctx.Err()
				break
			}
			var uploaded robot.FriendCircleUploadResponse
			uploaded, err = m.Upload(ctx, a.Data)
			if err != nil {
				break
			}
			media = append(media, uploaded)
		}
	}
	if err != nil {
		_, err = m.transition(id, "uploading", "failed", map[string]any{"error": "附件准备失败，未发布；请检查附件和机器人连接"})
		return err
	}
	// Plan and job cancellation use the same plan lock. Commit publishing BEFORE the external side effect.
	err = m.Store.DB.Transaction(func(tx *gorm.DB) error {
		p, e := lockPlan(tx, j.PlanID)
		if e != nil {
			return e
		}
		if p.Status == "paused" || p.Status == "cancelled" {
			ok = false
			return nil
		}
		r := tx.Model(&model.MomentPlanJob{}).Where("id = ? AND status = ?", id, "uploading").Updates(map[string]any{"status": "publishing", "updated_at": m.Now().Unix()})
		ok = r.RowsAffected == 1
		return r.Error
	})
	if err != nil || !ok {
		return err
	}
	if ctx.Err() != nil {
		_, err = m.transition(id, "publishing", "failed", map[string]any{"error": "服务停止，尚未调用发布接口"})
		return err
	}
	momentID, publishErr := m.Publish(ctx, j.Payload, media)
	if publishErr != nil || momentID == "" {
		// The server may have accepted the post even if the response was lost.
		return m.markUncertain(id, j.PlanID, "发布失败或结果未确认，请在微信核对；系统不会自动重发")
	}
	_, err = m.transition(id, "publishing", "published", map[string]any{"moment_id": momentID, "error": ""})
	return err
}

func (m *Manager) markUncertain(id, planID, reason string) error {
	return m.Store.DB.Transaction(func(tx *gorm.DB) error {
		p, err := lockPlan(tx, planID)
		if err != nil {
			return err
		}
		r := tx.Model(&model.MomentPlanJob{}).Where("id = ? AND status = ?", id, "publishing").Updates(map[string]any{"status": "uncertain", "error": reason, "updated_at": m.Now().Unix()})
		if r.Error != nil {
			return r.Error
		}
		if r.RowsAffected == 0 {
			return nil
		}
		if p.Status == "active" {
			if err := tx.Model(&p).Updates(map[string]any{"status": "paused", "updated_at": m.Now().Unix()}).Error; err != nil {
				return err
			}
			return tx.Model(&model.MomentPlanJob{}).Where("plan_id = ? AND status IN ?", planID, unsent).Updates(map[string]any{"status": "cancelled", "error": "此前发布结果待核对，计划已暂停", "updated_at": m.Now().Unix()}).Error
		}
		return nil
	})
}

func (m *Manager) recoverStale(now int64) error {
	var stale []model.MomentPlanJob
	if err := m.Store.DB.Where("status IN ? AND updated_at < ?", []string{"publishing", "uploading", "drafting"}, now-1800).Find(&stale).Error; err != nil {
		return err
	}
	for _, j := range stale {
		if j.Status == "publishing" {
			if err := m.markUncertain(j.ID, j.PlanID, "发布过程曾中断，请核对微信记录；未自动重发"); err != nil {
				return err
			}
		} else {
			if _, err := m.transition(j.ID, j.Status, "failed", map[string]any{"error": "生成或附件准备过程曾中断，未发布"}); err != nil {
				return err
			}
		}
	}
	return nil
}

var ErrNoEvidence = errors.New("所选知识库没有检索到相关资料，未生成发布内容")
