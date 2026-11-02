package model

// ChatRoomMemberDuplicate retains the original records before legacy duplicates
// are consolidated. It is not part of the active member list or member count.
type ChatRoomMemberDuplicate struct {
	OriginalMemberID  int64  `gorm:"primaryKey;autoIncrement:false"`
	CanonicalMemberID int64  `gorm:"not null"`
	ChatRoomID        string `gorm:"type:varchar(64);not null"`
	WechatID          string `gorm:"type:varchar(64);not null"`
	MemberSnapshot    string `gorm:"type:longtext;not null"`
	ArchivedAt        int64  `gorm:"not null"`
}

func (ChatRoomMemberDuplicate) TableName() string {
	return "chat_room_member_duplicates"
}
