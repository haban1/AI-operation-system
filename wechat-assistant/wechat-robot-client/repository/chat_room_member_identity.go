package repository

import (
	"context"
	"encoding/json"
	"time"

	"wechat-robot-client/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const ChatRoomMemberIdentityIndex = "idx_chat_room_member_identity"

// ConsolidateDuplicateChatRoomMembers runs at startup before adding the unique
// identity index, while no message handlers or API requests are running.
// Keep the oldest ID: this is the row that GetChatRoomMember has always used for
// permissions and balances. Archive all originals, and never add duplicate scores.
func ConsolidateDuplicateChatRoomMembers(ctx context.Context, db *gorm.DB) (int64, error) {
	if err := db.AutoMigrate(&model.ChatRoomMemberDuplicate{}); err != nil {
		return 0, err
	}
	var removed int64
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var identities []struct {
			ChatRoomID string
			WechatID   string
		}
		if err := tx.Model(&model.ChatRoomMember{}).Select("chat_room_id, wechat_id").
			Group("chat_room_id, wechat_id").Having("COUNT(*) > 1").Scan(&identities).Error; err != nil {
			return err
		}
		for _, identity := range identities {
			var members []model.ChatRoomMember
			if err := tx.Where("chat_room_id = ? AND wechat_id = ?", identity.ChatRoomID, identity.WechatID).
				Order("id ASC").Find(&members).Error; err != nil {
				return err
			}
			if len(members) < 2 {
				continue
			}
			canonical := members[0]
			for _, member := range members {
				snapshot, err := json.Marshal(member)
				if err != nil {
					return err
				}
				archive := model.ChatRoomMemberDuplicate{
					OriginalMemberID: member.ID, CanonicalMemberID: canonical.ID,
					ChatRoomID: member.ChatRoomID, WechatID: member.WechatID,
					MemberSnapshot: string(snapshot), ArchivedAt: time.Now().Unix(),
				}
				if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&archive).Error; err != nil {
					return err
				}
			}
			// Recover missing profile fields from the newest nonempty duplicate.
			// Membership will be verified by the next complete WeChat snapshot.
			for i := len(members) - 1; i > 0; i-- {
				member := members[i]
				if canonical.Nickname == "" {
					canonical.Nickname = member.Nickname
				}
				if canonical.Avatar == "" {
					canonical.Avatar = member.Avatar
				}
				if canonical.Alias == "" {
					canonical.Alias = member.Alias
				}
				if canonical.Remark == "" {
					canonical.Remark = member.Remark
				}
				if canonical.InviterWechatID == "" {
					canonical.InviterWechatID = member.InviterWechatID
				}
				if canonical.Sex == nil {
					canonical.Sex = member.Sex
				}
				if member.LastActiveAt > canonical.LastActiveAt {
					canonical.LastActiveAt = member.LastActiveAt
				}
				if member.JoinedAt > 0 && (canonical.JoinedAt == 0 || member.JoinedAt < canonical.JoinedAt) {
					canonical.JoinedAt = member.JoinedAt
				}
			}
			if err := tx.Model(&canonical).Select("nickname", "avatar", "alias", "remark", "inviter_wechat_id", "sex", "last_active_at", "joined_at").Updates(&canonical).Error; err != nil {
				return err
			}
			ids := make([]int64, 0, len(members)-1)
			for _, member := range members[1:] {
				ids = append(ids, member.ID)
			}
			result := tx.Where("id IN ?", ids).Delete(&model.ChatRoomMember{})
			if result.Error != nil {
				return result.Error
			}
			removed += result.RowsAffected
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return removed, nil
}
