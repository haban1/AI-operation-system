package model

import "gorm.io/datatypes"

type SupportSettings struct {
	ID             uint           `gorm:"primaryKey" json:"id"`
	Notifier       string         `gorm:"size:64" json:"notifier"`
	KnowledgeCodes datatypes.JSON `json:"knowledge_codes"`
}

type SupportReception struct {
	Key               string `gorm:"primaryKey;size:160" json:"key"`
	Peer              string `gorm:"size:64;index" json:"peer"`
	Room              string `gorm:"size:64" json:"room"`
	Active            bool   `gorm:"index" json:"active"`
	Version           int64  `json:"version"`
	Reason            string `gorm:"type:text" json:"reason"`
	LastMessage       string `gorm:"type:text" json:"last_message"`
	NotificationError string `gorm:"type:text" json:"notification_error"`
	StartedAt         int64  `json:"started_at"`
	UpdatedAt         int64  `json:"updated_at"`
}

type SupportBroadcast struct {
	ID           string         `gorm:"primaryKey;size:64" json:"id"`
	Fingerprint  string         `gorm:"size:64" json:"-"`
	Content      string         `gorm:"type:text" json:"content"`
	Recipients   datatypes.JSON `json:"recipients"`
	Image        []byte         `gorm:"type:longblob" json:"-"`
	ImageType    string         `gorm:"size:64" json:"-"`
	HasImage     bool           `json:"has_image"`
	Status       string         `gorm:"size:24;index" json:"status"`
	Results      datatypes.JSON `json:"results"`
	SuccessCount int            `json:"success_count"`
	FailedCount  int            `json:"failed_count"`
	CreatedAt    int64          `json:"created_at"`
	UpdatedAt    int64          `json:"updated_at"`
}
