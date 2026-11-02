package repository

import (
	"context"
	"errors"
	"strings"
	"time"
	"wechat-robot-client/dto"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/appx"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ChatRoomMember struct {
	Ctx context.Context
	DB  *gorm.DB
}

func NewChatRoomMemberRepo(ctx context.Context, db *gorm.DB) *ChatRoomMember {
	return &ChatRoomMember{
		Ctx: ctx,
		DB:  db,
	}
}

func (c *ChatRoomMember) GetByID(id int64) (*model.ChatRoomMember, error) {
	var chatRoomMember model.ChatRoomMember
	err := c.DB.WithContext(c.Ctx).Where("id = ?", id).First(&chatRoomMember).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &chatRoomMember, nil
}

func (c *ChatRoomMember) GetByChatRoomID(req dto.ChatRoomMemberListRequest, pager appx.Pager) ([]*model.ChatRoomMember, int64, error) {
	var chatRoomMembers []*model.ChatRoomMember
	var total int64
	query := c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{})
	query = query.Where("chat_room_id = ?", req.ChatRoomID)
	switch req.Membership {
	case "current":
		query = query.Where("(is_leaved = 0 OR is_leaved IS NULL) AND leaved_at IS NULL")
	case "left":
		query = query.Where("(is_leaved = 1 OR leaved_at IS NOT NULL)")
	}
	if req.Keyword != "" {
		query = query.Where("(nickname LIKE ? OR remark LIKE ?)", "%"+req.Keyword+"%", "%"+req.Keyword+"%")
	}
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	query = query.Order("last_active_at DESC").Order("id DESC")
	if err := query.Offset(pager.OffSet).Limit(pager.PageSize).Find(&chatRoomMembers).Error; err != nil {
		return nil, 0, err
	}
	return chatRoomMembers, total, nil
}

func (c *ChatRoomMember) GetNotLeftMemberByChatRoomID(req dto.ChatRoomMemberListRequest) ([]*model.ChatRoomMember, error) {
	var chatRoomMembers []*model.ChatRoomMember
	query := c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{})
	query = query.Where("chat_room_id = ? AND (is_leaved = 0 OR is_leaved IS NULL) AND leaved_at IS NULL", req.ChatRoomID)
	if req.Keyword != "" {
		query = query.Where("(nickname LIKE ? OR remark LIKE ?)", "%"+req.Keyword+"%", "%"+req.Keyword+"%")
	}
	if err := query.Find(&chatRoomMembers).Error; err != nil {
		return nil, err
	}
	return chatRoomMembers, nil
}

func (c *ChatRoomMember) GetChatRoomMember(chatRoomID, wechatID string) (*model.ChatRoomMember, error) {
	var chatRoomMember model.ChatRoomMember
	err := c.DB.WithContext(c.Ctx).Where("chat_room_id = ? AND wechat_id = ?", chatRoomID, wechatID).First(&chatRoomMember).Error
	if err == gorm.ErrRecordNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &chatRoomMember, nil
}

func (c *ChatRoomMember) GetChatRoomMemberByWeChatID(wechatID string) ([]*model.ChatRoomMember, error) {
	var chatRoomMember []*model.ChatRoomMember
	err := c.DB.WithContext(c.Ctx).Where("wechat_id = ?", wechatID).Find(&chatRoomMember).Error
	if err != nil {
		return nil, err
	}
	return chatRoomMember, nil
}

func (c *ChatRoomMember) GetChatRoomMemberByWeChatIDs(chatRoomID string, wechatIDs []string) ([]*model.ChatRoomMember, error) {
	var chatRoomMembers []*model.ChatRoomMember
	err := c.DB.WithContext(c.Ctx).Where("chat_room_id = ? AND wechat_id IN ?", chatRoomID, wechatIDs).Find(&chatRoomMembers).Error
	if err != nil {
		return nil, err
	}
	return chatRoomMembers, nil
}

// GetChatRoomMembers 获取未退出群聊的成员
func (c *ChatRoomMember) GetChatRoomMembers(chatRoomID string) ([]*model.ChatRoomMember, error) {
	var chatRoomMembers []*model.ChatRoomMember
	err := c.DB.WithContext(c.Ctx).Where("chat_room_id = ? AND (is_leaved = 0 OR is_leaved IS NULL) AND leaved_at IS NULL", chatRoomID).Find(&chatRoomMembers).Error
	if err != nil {
		return nil, err
	}
	return chatRoomMembers, nil
}

// 当前群总人数
func (c *ChatRoomMember) GetChatRoomMemberCount(chatRoomID string) (int64, error) {
	var total int64
	query := c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{})
	query = query.Where("chat_room_id = ?", chatRoomID).Where("(is_leaved = 0 OR is_leaved IS NULL) AND leaved_at IS NULL")
	if err := query.Count(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

// 昨天入群人数
func (c *ChatRoomMember) GetYesterdayJoinCount(chatRoomID string) (int64, error) {
	var total int64
	// 获取今天凌晨零点
	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	// 获取昨天凌晨零点
	yesterdayStart := todayStart.AddDate(0, 0, -1)
	// 转换为时间戳（秒）
	yesterdayStartTimestamp := yesterdayStart.Unix()
	todayStartTimestamp := todayStart.Unix()
	query := c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{})
	query = query.Where("chat_room_id = ?", chatRoomID).
		Where("joined_at >= ?", yesterdayStartTimestamp).
		Where("joined_at < ?", todayStartTimestamp)
	if err := query.Count(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

// 昨天离群人数
func (c *ChatRoomMember) GetYesterdayLeaveCount(chatRoomID string) (int64, error) {
	var total int64
	// 获取今天凌晨零点
	now := time.Now()
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	// 获取昨天凌晨零点
	yesterdayStart := todayStart.AddDate(0, 0, -1)
	// 转换为时间戳（秒）
	yesterdayStartTimestamp := yesterdayStart.Unix()
	todayStartTimestamp := todayStart.Unix()
	query := c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{})
	query = query.Where("chat_room_id = ?", chatRoomID).
		Where("leaved_at >= ?", yesterdayStartTimestamp).
		Where("leaved_at < ?", todayStartTimestamp)
	if err := query.Count(&total).Error; err != nil {
		return 0, err
	}
	return total, nil
}

func (c *ChatRoomMember) Create(data *model.ChatRoomMember) error {
	if strings.TrimSpace(data.ChatRoomID) == "" || strings.TrimSpace(data.WechatID) == "" {
		return errors.New("群 ID 和成员微信 ID 不能为空")
	}
	// A message and a member refresh can discover the same account concurrently.
	// An existing profile/settings record must not be overwritten by a blank one.
	if err := c.DB.WithContext(c.Ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(data).Error; err != nil {
		return err
	}
	var existing model.ChatRoomMember
	if err := c.DB.WithContext(c.Ctx).Select("id").Where("chat_room_id = ? AND wechat_id = ?", data.ChatRoomID, data.WechatID).First(&existing).Error; err != nil {
		return err
	}
	data.ID = existing.ID
	return nil
}

func (c *ChatRoomMember) Update(data *model.ChatRoomMember) error {
	return c.DB.WithContext(c.Ctx).Where("id = ?", data.ID).Updates(data).Error
}

func (c *ChatRoomMember) UpdateByID(id int64, data map[string]any) error {
	return c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{}).Where("id = ?", id).Updates(data).Error
}

func (c *ChatRoomMember) DeleteChatRoomMembers(memberIDs []string) error {
	return c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{}).
		Where("wechat_id IN (?)", memberIDs).
		Update("is_leaved", 1).
		Update("leaved_at", time.Now().Unix()).
		Error
}

func (c *ChatRoomMember) AtomicUpdateScores(chatRoomID, wechatID string, updates map[string]any) error {
	db := c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{}).
		Where("chat_room_id = ? AND wechat_id = ?", chatRoomID, wechatID)
	return db.Updates(updates).Error
}

func (c *ChatRoomMember) UpdateMemberInfo(chatRoomID, wechatID string, updates map[string]any) error {
	return c.DB.WithContext(c.Ctx).Model(&model.ChatRoomMember{}).
		Where("chat_room_id = ? AND wechat_id = ?", chatRoomID, wechatID).
		Updates(updates).Error
}
