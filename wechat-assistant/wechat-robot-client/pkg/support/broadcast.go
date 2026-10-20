package support

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
	"wechat-robot-client/model"
)

var requestIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)

func (m *Manager) Submit(id, content string, recipients []string, image []byte, confirmed bool) (model.SupportBroadcast, error) {
	job := model.SupportBroadcast{}
	if !confirmed || !requestIDPattern.MatchString(id) {
		return job, errors.New("请确认发送并提供有效请求编号")
	}
	content = strings.TrimSpace(content)
	if utf8.RuneCountInString(content) > 2000 || (content == "" && len(image) == 0) || len(image) > 10*1024*1024 {
		return job, errors.New("文字最多 2000 字，图片最大 10 MB，内容不能为空")
	}
	mime := ""
	if len(image) > 0 {
		mime = http.DetectContentType(image)
		if mime != "image/jpeg" && mime != "image/png" && mime != "image/gif" && mime != "image/webp" {
			return job, errors.New("请选择 PNG、JPEG、GIF 或 WebP 图片")
		}
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, peer := range recipients {
		if !seen[peer] {
			seen[peer] = true
			ids = append(ids, peer)
		}
	}
	if len(ids) == 0 || len(ids) > 500 {
		return job, errors.New("请选择 1 至 500 位好友")
	}
	payload, _ := json.Marshal(ids)
	hash := sha256.New()
	hash.Write([]byte(content))
	hash.Write([]byte{0})
	hash.Write(payload)
	hash.Write([]byte{0})
	hash.Write(image)
	fingerprint := hex.EncodeToString(hash.Sum(nil))
	err := m.DB.First(&job, "id = ?", id).Error
	if err == nil {
		if job.Fingerprint != fingerprint {
			return job, errors.New("请求编号已用于另一条群发")
		}
		return job, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return job, err
	}
	for _, peer := range ids {
		if !m.IsFriend(peer) {
			return job, fmt.Errorf("收件人不是当前好友：%s", peer)
		}
	}
	now := time.Now().Unix()
	job = model.SupportBroadcast{ID: id, Fingerprint: fingerprint, Content: content, Recipients: payload, Image: image, ImageType: mime, HasImage: len(image) > 0, Status: "pending", Results: []byte("[]"), CreatedAt: now, UpdatedAt: now}
	if err = m.DB.Create(&job).Error; err != nil {
		var existing model.SupportBroadcast
		if e := m.DB.First(&existing, "id = ?", id).Error; e == nil && existing.Fingerprint == fingerprint {
			return existing, nil
		}
		return job, err
	}
	return job, nil
}

type Delivery struct {
	Peer      string `json:"peer"`
	TextSent  bool   `json:"text_sent"`
	ImageSent bool   `json:"image_sent"`
	Error     string `json:"error,omitempty"`
}

func (m *Manager) RunBroadcast(ctx context.Context, id string) error {
	claim := m.DB.Model(&model.SupportBroadcast{}).Where("id = ? AND status = ?", id, "pending").Update("status", "running")
	if claim.Error != nil {
		return claim.Error
	}
	if claim.RowsAffected == 0 {
		return nil
	}
	var job model.SupportBroadcast
	if err := m.DB.First(&job, "id = ?", id).Error; err != nil {
		return err
	}
	var peers []string
	if err := json.Unmarshal(job.Recipients, &peers); err != nil {
		return err
	}
	results := []Delivery{}
	persist := func() error {
		job.Results, _ = json.Marshal(results)
		job.UpdatedAt = time.Now().Unix()
		return m.DB.Model(&model.SupportBroadcast{}).Where("id = ?", id).Updates(map[string]any{"status": job.Status, "results": job.Results, "success_count": job.SuccessCount, "failed_count": job.FailedCount, "updated_at": job.UpdatedAt}).Error
	}
	for i, peer := range peers {
		if ctx.Err() != nil {
			job.Status = "interrupted"
			return persist()
		}
		result := Delivery{Peer: peer}
		if !m.IsFriend(peer) {
			result.Error = "好友已不可用"
		} else {
			if job.Content != "" {
				if err := m.SendText(peer, job.Content); err != nil {
					result.Error = "文字发送失败或结果未确认，请核对微信记录"
				} else {
					result.TextSent = true
				}
			}
			if result.Error == "" && job.HasImage {
				if err := m.SendImage(peer, job.Image); err != nil {
					result.Error = "图片发送失败或结果未确认，请核对微信记录"
				} else {
					result.ImageSent = true
				}
			}
		}
		if result.Error != "" {
			job.FailedCount++
		} else {
			job.SuccessCount++
		}
		results = append(results, result)
		if err := persist(); err != nil {
			return err
		} // Stop if results cannot be saved; never silently resend.
		if i < len(peers)-1 {
			select {
			case <-ctx.Done():
				job.Status = "interrupted"
				return persist()
			case <-time.After(m.Interval):
			}
		}
	}
	job.Status = "completed"
	if job.FailedCount > 0 {
		job.Status = "partial"
		if job.SuccessCount == 0 {
			job.Status = "failed"
		}
	}
	return persist()
}

func (m *Manager) Start(ctx context.Context) error {
	// A process crash may happen after delivery but before recording success.
	// Expose uncertainty instead of automatically replaying those messages.
	if err := m.DB.Model(&model.SupportBroadcast{}).Where("status = ?", "running").Update("status", "interrupted").Error; err != nil {
		return err
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				var jobs []model.SupportBroadcast
				if err := m.DB.Select("id").Where("status = ?", "pending").Order("created_at").Limit(1).Find(&jobs).Error; err != nil {
					log.Printf("[Support] queue: %v", err)
					continue
				}
				for _, job := range jobs {
					if err := m.RunBroadcast(ctx, job.ID); err != nil {
						log.Printf("[Support] broadcast: %v", err)
						m.DB.Model(&job).Update("status", "interrupted")
					}
				}
			}
		}
	}()
	return nil
}
