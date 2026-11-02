package support

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
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

const MaxBroadcastImages = 3
const MaxBroadcastImageBytes = 10 * 1024 * 1024
const MaxBroadcastRequestBytes = 32 * 1024 * 1024

func (m *Manager) Submit(id, content string, recipients []string, image []byte, confirmed bool) (model.SupportBroadcast, error) {
	var images [][]byte
	if len(image) > 0 {
		images = append(images, image)
	}
	return m.SubmitImages(id, content, recipients, images, confirmed)
}

func (m *Manager) SubmitImages(id, content string, recipients []string, images [][]byte, confirmed bool) (model.SupportBroadcast, error) {
	job := model.SupportBroadcast{}
	if !confirmed || !requestIDPattern.MatchString(id) {
		return job, errors.New("请确认发送并提供有效请求编号")
	}
	content = strings.TrimSpace(content)
	if utf8.RuneCountInString(content) > 2000 || (content == "" && len(images) == 0) {
		return job, errors.New("文字最多 2000 字，内容不能为空")
	}
	if len(images) > MaxBroadcastImages {
		return job, errors.New("一次最多发送 3 张图片")
	}
	assets := make([]model.SupportBroadcastImage, 0, len(images))
	for i, image := range images {
		if len(image) == 0 || len(image) > MaxBroadcastImageBytes {
			return job, fmt.Errorf("第 %d 张图片不能为空且不能超过 10 MB", i+1)
		}
		mime := http.DetectContentType(image)
		if mime != "image/jpeg" && mime != "image/png" && mime != "image/gif" && mime != "image/webp" {
			return job, fmt.Errorf("第 %d 张图片请选择 PNG、JPEG、GIF 或 WebP 格式", i+1)
		}
		assets = append(assets, model.SupportBroadcastImage{BroadcastID: id, Position: i + 1, Image: image, ImageType: mime})
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
	// Preserve fingerprints for old text/single-image requests; include boundaries
	// and ordering for multi-image requests so changed content cannot reuse an ID.
	if len(images) > 1 {
		hash.Write([]byte("\x00multiple-images\x00"))
	}
	for _, image := range images {
		if len(images) > 1 {
			_ = binary.Write(hash, binary.BigEndian, uint64(len(image)))
		}
		hash.Write(image)
	}
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
	job = model.SupportBroadcast{ID: id, Fingerprint: fingerprint, Content: content, Recipients: payload, HasImage: len(images) > 0, ImageCount: len(images), Status: "pending", Results: []byte("[]"), CreatedAt: now, UpdatedAt: now}
	err = m.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&job).Error; err != nil {
			return err
		}
		// Separate inserts keep each database packet within the per-image limit.
		for i := range assets {
			if err := tx.Create(&assets[i]).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		var existing model.SupportBroadcast
		if e := m.DB.First(&existing, "id = ?", id).Error; e == nil && existing.Fingerprint == fingerprint {
			return existing, nil
		}
		return job, err
	}
	return job, nil
}

type Delivery struct {
	Peer       string `json:"peer"`
	TextSent   bool   `json:"text_sent"`
	ImageSent  bool   `json:"image_sent"`
	ImagesSent int    `json:"images_sent"`
	Error      string `json:"error,omitempty"`
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
	var images []model.SupportBroadcastImage
	if job.ImageCount > 0 {
		if err := m.DB.Where("broadcast_id = ?", job.ID).Order("position").Find(&images).Error; err != nil {
			return err
		}
		if len(images) != job.ImageCount || len(images) > MaxBroadcastImages {
			return errors.New("群发图片不完整，已停止发送")
		}
	} else if job.HasImage {
		if len(job.Image) == 0 {
			return errors.New("群发图片缺失，已停止发送")
		}
		images = []model.SupportBroadcastImage{{Image: job.Image, ImageType: job.ImageType}}
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
			if result.Error == "" {
				for imageIndex, image := range images {
					if imageIndex > 0 {
						select {
						case <-ctx.Done():
						case <-time.After(m.Interval):
						}
					}
					if ctx.Err() != nil {
						result.Error = "任务已中断，请核对已发送的图片"
						break
					}
					if err := m.SendImage(peer, image.Image); err != nil {
						result.Error = fmt.Sprintf("第 %d/%d 张图片发送失败或结果未确认，请核对微信记录", imageIndex+1, len(images))
						break
					}
					result.ImagesSent++
				}
				result.ImageSent = len(images) > 0 && result.ImagesSent == len(images)
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
		if ctx.Err() != nil {
			job.Status = "interrupted"
			return persist()
		}
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
