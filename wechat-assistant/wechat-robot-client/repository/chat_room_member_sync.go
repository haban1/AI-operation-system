package repository

import (
	"errors"
	"strings"
	"time"

	"wechat-robot-client/model"

	"gorm.io/gorm"
)

// ReconcileMembers commits one complete, validated WeChat snapshot atomically.
// Local member settings, scores and activity history are preserved.
func (c *ChatRoomMember) ReconcileMembers(chatRoomID string, members []model.ChatRoomMember) ([]string, error) {
	if chatRoomID == "" || len(members) == 0 {
		return nil, errors.New("群成员名单为空，未更新本地记录")
	}
	present := make(map[string]bool, len(members))
	for _, member := range members {
		if strings.TrimSpace(member.WechatID) == "" || present[member.WechatID] {
			return nil, errors.New("群成员名单异常，未更新本地记录")
		}
		present[member.WechatID] = true
	}
	var departed []string
	err := c.DB.WithContext(c.Ctx).Transaction(func(tx *gorm.DB) error {
		var existing []model.ChatRoomMember
		if err := tx.Where("chat_room_id = ?", chatRoomID).Find(&existing).Error; err != nil {
			return err
		}
		byID := make(map[string]model.ChatRoomMember, len(existing))
		for _, member := range existing {
			byID[member.WechatID] = member
		}
		now := time.Now().Unix()
		for _, member := range members {
			if old, ok := byID[member.WechatID]; ok {
				updates := map[string]any{
					"remark": member.Remark, "inviter_wechat_id": member.InviterWechatID,
					"is_leaved": false, "leaved_at": nil,
				}
				// Occasionally WeChat omits profile fields. Retain the last known profile.
				if member.Nickname != "" {
					updates["nickname"] = member.Nickname
				}
				if member.Avatar != "" {
					updates["avatar"] = member.Avatar
				}
				if (old.IsLeaved != nil && *old.IsLeaved) || old.LeavedAt != nil {
					updates["joined_at"] = now
				}
				if err := tx.Model(&model.ChatRoomMember{}).
					Where("chat_room_id = ? AND wechat_id = ?", chatRoomID, member.WechatID).Updates(updates).Error; err != nil {
					return err
				}
			} else {
				member.ChatRoomID = chatRoomID
				member.JoinedAt, member.LastActiveAt = now, now
				if err := tx.Create(&member).Error; err != nil {
					return err
				}
			}
		}
		departedIDs := make(map[string]bool)
		for _, old := range existing {
			if present[old.WechatID] || (old.IsLeaved != nil && *old.IsLeaved) || old.LeavedAt != nil {
				continue
			}
			if err := tx.Model(&model.ChatRoomMember{}).Where("id = ?", old.ID).
				Updates(map[string]any{"is_leaved": true, "leaved_at": now}).Error; err != nil {
				return err
			}
			departedIDs[old.WechatID] = true
			name := old.Remark
			if name == "" {
				name = old.Nickname
			}
			if name != "" {
				departed = append(departed, name)
			}
		}
		if len(departedIDs) == 0 {
			return nil
		}
		var settings model.ChatRoomSettings
		err := tx.Where("chat_room_id = ?", chatRoomID).First(&settings).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if settings.WxhbNotifyMemberList != nil && *settings.WxhbNotifyMemberList != "" {
			retained := []string{}
			for _, id := range strings.Split(*settings.WxhbNotifyMemberList, ",") {
				if !departedIDs[id] {
					retained = append(retained, id)
				}
			}
			return tx.Model(&settings).Update("wxhb_notify_member_list", strings.Join(retained, ",")).Error
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return departed, nil
}
