// Package support owns reception state and broadcast tasks in the robot database.
package support

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
	"wechat-robot-client/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var Default *Manager

type Manager struct {
	DB        *gorm.DB
	SendText  func(string, string, ...string) error
	SendImage func(string, []byte) error
	locks     sync.Map
	Interval  time.Duration
}

func New(db *gorm.DB) *Manager     { return &Manager{DB: db, Interval: 800 * time.Millisecond} }
func Key(peer, room string) string { return room + ":" + peer }
func (m *Manager) mutex(key string) *sync.Mutex {
	v, _ := m.locks.LoadOrStore(key, &sync.Mutex{})
	return v.(*sync.Mutex)
}

func (m *Manager) Settings() (model.SupportSettings, error) {
	s := model.SupportSettings{ID: 1}
	err := m.DB.First(&s, 1).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		s.KnowledgeCodes = []byte("[]")
		err = nil
	}
	return s, err
}

func (m *Manager) SaveSettings(s model.SupportSettings) error {
	s.ID = 1
	if s.Notifier != "" && !m.IsFriend(s.Notifier) {
		return errors.New("接待通知人必须是当前微信好友")
	}
	var codes []string
	if json.Unmarshal(s.KnowledgeCodes, &codes) != nil {
		return errors.New("请选择有效的知识库")
	}
	for _, code := range codes {
		var count int64
		if err := m.DB.Model(&model.KnowledgeCategory{}).Where("code = ? AND type = ?", code, "text").Count(&count).Error; err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("知识库不存在：%s", code)
		}
	}
	return m.DB.Save(&s).Error
}

func (m *Manager) IsFriend(peer string) bool {
	var n int64
	return m.DB.Model(&model.Contact{}).Where("wechat_id = ? AND type = ? AND (status IS NULL OR status <> ?)", peer, model.ContactTypeFriend, model.ContactStatusMissing).Count(&n).Error == nil && n == 1
}

func (m *Manager) state(peer, room string) (model.SupportReception, error) {
	r := model.SupportReception{Key: Key(peer, room), Peer: peer, Room: room, Version: 1}
	if err := m.DB.Clauses(clause.OnConflict{DoNothing: true}).Create(&r).Error; err != nil {
		return r, err
	}
	err := m.DB.First(&r, "`key` = ?", r.Key).Error
	return r, err
}

// Begin captures a generation version. Resuming AI never revives an old answer.
func (m *Manager) Begin(peer, room string) (int64, bool) {
	lock := m.mutex(Key(peer, room))
	lock.Lock()
	defer lock.Unlock()
	r, err := m.state(peer, room)
	return r.Version, err == nil && !r.Active
}

// Permit serializes sending against takeover, and checks state again after generation.
func (m *Manager) Permit(peer, room string, version int64) (func(), bool) {
	lock := m.mutex(Key(peer, room))
	lock.Lock()
	r, err := m.state(peer, room)
	if err != nil || r.Active || r.Version != version {
		lock.Unlock()
		return func() {}, false
	}
	return lock.Unlock, true
}

func (m *Manager) Transition(peer, room string, active bool, reason string) (model.SupportReception, bool, error) {
	return m.transition(peer, room, active, reason, 0)
}

func (m *Manager) transition(peer, room string, active bool, reason string, expectedVersion int64) (model.SupportReception, bool, error) {
	if peer == "" || len(peer) > 64 || len(room) > 64 || strings.Contains(peer, "@chatroom") {
		return model.SupportReception{}, false, errors.New("会话参数无效")
	}
	lock := m.mutex(Key(peer, room))
	lock.Lock()
	defer lock.Unlock()
	r, err := m.state(peer, room)
	if err != nil {
		return r, false, err
	}
	if expectedVersion > 0 && (r.Active || r.Version != expectedVersion) {
		return r, false, nil
	}
	changed := r.Active != active
	if changed {
		r.Version++
		r.Active = active
		r.NotificationError = ""
		if active {
			r.StartedAt = time.Now().Unix()
		}
	}
	if reason != "" {
		r.Reason = reason
	}
	r.UpdatedAt = time.Now().Unix()
	return r, changed, m.DB.Save(&r).Error
}

func (m *Manager) Takeover(peer, room, reason string) error {
	_, err := m.TakeoverForTurn(peer, room, reason, 0)
	return err
}

// A stale or duplicate model tool call must not take over a resumed conversation.
func (m *Manager) TakeoverForTurn(peer, room, reason string, version int64) (bool, error) {
	r, changed, err := m.transition(peer, room, true, reason, version)
	if err != nil || !changed {
		return false, err
	}
	s, err := m.Settings()
	if err != nil {
		return true, err
	}
	if s.Notifier != "" && m.SendText != nil {
		err = m.SendText(s.Notifier, fmt.Sprintf("需要人工接待\n客户：%s\n原因：%s\n请在微信接待，完成后在机器人后台恢复 AI。", peer, reason))
		if err != nil {
			m.DB.Model(&r).Update("notification_error", "通知发送失败，请直接查看接待队列")
			log.Printf("[Support] notification failed: %v", err)
		}
	}
	return true, nil // Takeover remains effective even if the notification fails.
}

func (m *Manager) Observe(peer, room, content string) {
	m.DB.Model(&model.SupportReception{}).Where("`key` = ? AND active = ?", Key(peer, room), true).Updates(map[string]any{"last_message": content, "updated_at": time.Now().Unix()})
}

func (m *Manager) Snapshot() (map[string]any, error) {
	s, err := m.Settings()
	if err != nil {
		return nil, err
	}
	var friends []model.Contact
	var receptions []model.SupportReception
	var jobs []model.SupportBroadcast
	var categories []model.KnowledgeCategory
	for _, q := range []*gorm.DB{
		m.DB.Where("type = ? AND (status IS NULL OR status <> ?)", model.ContactTypeFriend, model.ContactStatusMissing).Find(&friends),
		m.DB.Where("active = ?", true).Order("updated_at desc").Find(&receptions),
		m.DB.Omit("image").Order("created_at desc").Limit(30).Find(&jobs),
		m.DB.Where("type = ?", "text").Find(&categories),
	} {
		if q.Error != nil {
			return nil, q.Error
		}
	}
	return map[string]any{"settings": s, "friends": friends, "receptions": receptions, "broadcasts": jobs, "categories": categories}, nil
}
