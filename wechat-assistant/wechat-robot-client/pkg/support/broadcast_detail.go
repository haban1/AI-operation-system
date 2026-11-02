package support

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"gorm.io/gorm"
	"wechat-robot-client/model"
)

type BroadcastFriend struct {
	WechatID string `json:"wechat_id"`
	Nickname string `json:"nickname"`
	Remark   string `json:"remark"`
	Avatar   string `json:"avatar"`
}

type BroadcastDetail struct {
	Job     model.SupportBroadcast `json:"job"`
	Friends []BroadcastFriend      `json:"friends"`
}

func (m *Manager) broadcastRecord(id string) (model.SupportBroadcast, error) {
	var job model.SupportBroadcast
	if strings.TrimSpace(id) == "" || len(id) > 64 {
		return job, errors.New("群发任务编号无效")
	}
	err := m.DB.Omit("image").First(&job, "id = ?", id).Error
	return job, err
}

// BroadcastDetails reads saved results only; opening a record never queues sends.
func (m *Manager) BroadcastDetails(id string) (BroadcastDetail, error) {
	job, err := m.broadcastRecord(id)
	if err != nil {
		return BroadcastDetail{}, err
	}
	detail := BroadcastDetail{Job: job, Friends: []BroadcastFriend{}}
	var peers []string
	if err := json.Unmarshal(job.Recipients, &peers); err != nil {
		return detail, fmt.Errorf("读取群发收件人失败: %w", err)
	}
	if len(peers) > 0 {
		// Include retained contacts that have since left the address book.
		err = m.DB.Model(&model.Contact{}).Unscoped().Select("wechat_id, nickname, remark, avatar").Where("wechat_id IN ?", peers).Scan(&detail.Friends).Error
	}
	return detail, err
}

func (m *Manager) BroadcastImage(id string, position int) ([]byte, string, error) {
	if position < 1 || position > MaxBroadcastImages {
		return nil, "", errors.New("图片序号无效")
	}
	job, err := m.broadcastRecord(id)
	if err != nil {
		return nil, "", err
	}
	var asset model.SupportBroadcastImage
	if job.ImageCount > 0 && position <= job.ImageCount {
		err = m.DB.First(&asset, "broadcast_id = ? AND position = ?", id, position).Error
	} else if job.ImageCount == 0 && job.HasImage && position == 1 {
		// Historical jobs kept the single image on the task itself.
		var legacy model.SupportBroadcast
		err = m.DB.Select("image").First(&legacy, "id = ?", id).Error
		asset.Image = legacy.Image
	} else {
		err = gorm.ErrRecordNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if len(asset.Image) == 0 {
		return nil, "", gorm.ErrRecordNotFound
	}
	mime := http.DetectContentType(asset.Image)
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return asset.Image, mime, nil
	default:
		return nil, "", errors.New("保存的图片格式无效")
	}
}
