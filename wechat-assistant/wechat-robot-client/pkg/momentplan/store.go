package momentplan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"time"
	"unicode/utf8"
	"wechat-robot-client/model"

	"github.com/google/uuid"
	"github.com/h2non/filetype"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Store struct{ DB *gorm.DB }
type Snapshot struct {
	Plans      []model.MomentPlan        `json:"plans"`
	Jobs       []model.MomentPlanJob     `json:"jobs"`
	Categories []model.KnowledgeCategory `json:"categories"`
	Assets     []model.MomentPlanAsset   `json:"assets"`
}

func (s *Store) Snapshot() (Snapshot, error) {
	out := Snapshot{Plans: []model.MomentPlan{}, Jobs: []model.MomentPlanJob{}, Categories: []model.KnowledgeCategory{}, Assets: []model.MomentPlanAsset{}}
	if err := s.DB.Order("created_at desc").Limit(200).Find(&out.Plans).Error; err != nil {
		return out, err
	}
	if err := s.DB.Order("created_at desc").Limit(200).Find(&out.Jobs).Error; err != nil {
		return out, err
	}
	if err := s.DB.Where("type = ?", "text").Find(&out.Categories).Error; err != nil {
		return out, err
	}
	ids := []string{}
	for _, p := range out.Plans {
		ids = append(ids, p.Payload.AssetIDs...)
	}
	if len(ids) > 0 {
		if err := s.DB.Omit("data").Where("id IN ?", ids).Find(&out.Assets).Error; err != nil {
			return out, err
		}
	}
	return out, nil
}

func (s *Store) SaveAsset(name string, data []byte) (model.MomentPlanAsset, error) {
	a := model.MomentPlanAsset{}
	mediaType := ""
	if filetype.IsImage(data) {
		mediaType = "image"
	} else if filetype.IsVideo(data) {
		mediaType = "video"
	}
	if mediaType == "" || len(data) == 0 || len(data) > 30*1024*1024 || (mediaType == "image" && len(data) > 10*1024*1024) {
		return a, errors.New("请选择10MB以内的图片或30MB以内的视频")
	}
	name = filepath.Base(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > 200 {
		name = "附件"
	}
	a = model.MomentPlanAsset{ID: uuid.NewString(), Name: name, MediaType: mediaType, Data: data, Size: len(data), CreatedAt: time.Now().Unix()}
	return a, s.DB.Create(&a).Error
}

func (s *Store) Assets(ids []string) ([]model.MomentPlanAsset, error) {
	result := []model.MomentPlanAsset{}
	for _, id := range ids {
		var a model.MomentPlanAsset
		if err := s.DB.First(&a, "id = ?", id).Error; err != nil {
			return nil, errors.New("计划附件不存在，请重新上传")
		}
		result = append(result, a)
	}
	return result, nil
}

func (s *Store) Create(r CreateRequest, now int64) (model.MomentPlan, error) {
	var existing model.MomentPlan
	// Compare the original request before time validation, so a lost response can be retried after its due time.
	encoded, err := json.Marshal(r)
	if err != nil {
		return existing, err
	}
	sum := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(sum[:])
	err = s.DB.First(&existing, "id = ?", r.ID).Error
	if err == nil {
		if existing.Fingerprint != fingerprint {
			return existing, errors.New("请求编号已用于其他计划")
		}
		return existing, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return existing, err
	}
	if err = validateCreate(&r, now); err != nil {
		return existing, err
	}
	assets, err := s.Assets(r.Payload.AssetIDs)
	if err != nil {
		return existing, err
	}
	total := 0
	for _, a := range assets {
		total += a.Size
		if a.MediaType == "video" && len(assets) != 1 {
			return existing, errors.New("视频不能与其他附件混合")
		}
	}
	if total > 40*1024*1024 {
		return existing, errors.New("附件总大小不能超过40MB")
	}
	for _, code := range r.KnowledgeCodes {
		var count int64
		if err = s.DB.Model(&model.KnowledgeCategory{}).Where("code = ? AND type = ?", code, "text").Count(&count).Error; err != nil {
			return existing, err
		}
		if count != 1 {
			return existing, fmt.Errorf("知识库不可用：%s", code)
		}
	}
	p := model.MomentPlan{ID: r.ID, Fingerprint: fingerprint, Name: r.Name, Kind: r.Kind, Status: "active", Topic: r.Topic, Instructions: r.Instructions, KnowledgeCodes: r.KnowledgeCodes, PublishMode: r.PublishMode, Repeat: r.Repeat, Timezone: r.Timezone, FirstRunAt: r.FirstRunAt, NextRunAt: r.FirstRunAt, Payload: r.Payload, CreatedAt: now, UpdatedAt: now}
	err = s.DB.Create(&p).Error
	if err != nil {
		if e := s.DB.First(&existing, "id = ?", r.ID).Error; e == nil && existing.Fingerprint == fingerprint {
			return existing, nil
		}
	}
	return p, err
}

var unsent = []string{"generating", "drafting", "awaiting_review", "scheduled", "uploading"}

func lockPlan(tx *gorm.DB, id string) (model.MomentPlan, error) {
	var p model.MomentPlan
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&p, "id = ?", id).Error
	return p, err
}

func (s *Store) PlanAction(id, action string, now int64) error {
	return s.DB.Transaction(func(tx *gorm.DB) error {
		p, err := lockPlan(tx, id)
		if err != nil {
			return err
		}
		if action == "resume" {
			if p.Status != "paused" || p.Repeat == "once" {
				return errors.New("仅暂停中的周期计划可以恢复；单次计划请重新创建")
			}
			// A draft may already exist for a future occurrence. Never recreate it on resume.
			var latest int64
			if err := tx.Model(&model.MomentPlanJob{}).Where("plan_id = ?", id).Select("COALESCE(MAX(occurrence_at), 0)").Scan(&latest).Error; err != nil {
				return err
			}
			after := now
			if latest > after {
				after = latest
			}
			next, err := NextOccurrence(p.FirstRunAt, after, p.Repeat, p.Timezone)
			if err != nil {
				return err
			}
			return tx.Model(&p).Updates(map[string]any{"status": "active", "next_run_at": next, "updated_at": now}).Error
		}
		if action != "pause" && action != "cancel" {
			return errors.New("操作无效")
		}
		if p.Status == "cancelled" {
			return nil
		}
		var running int64
		if err = tx.Model(&model.MomentPlanJob{}).Where("plan_id = ? AND status = ?", id, "publishing").Count(&running).Error; err != nil {
			return err
		}
		if running > 0 {
			return errors.New("当前任务正在发布，请等待结果后再操作")
		}
		status := "paused"
		if action == "cancel" {
			status = "cancelled"
		}
		if err = tx.Model(&p).Updates(map[string]any{"status": status, "updated_at": now}).Error; err != nil {
			return err
		}
		return tx.Model(&model.MomentPlanJob{}).Where("plan_id = ? AND status IN ?", id, unsent).Updates(map[string]any{"status": "cancelled", "error": "计划已暂停或取消", "updated_at": now}).Error
	})
}

type JobActionRequest struct {
	JobID       string `json:"job_id"`
	Action      string `json:"action"`
	Content     string `json:"content"`
	ScheduledAt int64  `json:"scheduled_at"`
}

func (s *Store) JobAction(r JobActionRequest, now int64) error {
	var before model.MomentPlanJob
	if err := s.DB.First(&before, "id = ?", r.JobID).Error; err != nil {
		return err
	}
	return s.DB.Transaction(func(tx *gorm.DB) error {
		p, err := lockPlan(tx, before.PlanID)
		if err != nil {
			return err
		}
		var j model.MomentPlanJob
		if err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&j, "id = ?", r.JobID).Error; err != nil {
			return err
		}
		if r.Action == "cancel" {
			if j.Status == "cancelled" {
				return nil
			}
			if !slices.Contains(unsent, j.Status) {
				return errors.New("该任务已执行，无法取消")
			}
			return tx.Model(&j).Updates(map[string]any{"status": "cancelled", "updated_at": now}).Error
		}
		if r.Action != "approve" || j.Status != "awaiting_review" {
			return errors.New("仅待审核文案可以审核发布")
		}
		if p.Status == "paused" || p.Status == "cancelled" {
			return errors.New("计划已暂停或取消")
		}
		if r.ScheduledAt <= now || r.ScheduledAt > now+366*86400 {
			return errors.New("请选择未来一年内的发布时间")
		}
		j.Payload.Content = r.Content
		if err = validateContent(j.Payload, false); err != nil {
			return err
		}
		j.Status = "scheduled"
		j.ScheduledAt = r.ScheduledAt
		j.UpdatedAt = now
		return tx.Save(&j).Error
	})
}
