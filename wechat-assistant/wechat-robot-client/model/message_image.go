package model

// Image bytes live separately so chat list queries never load or expose blobs.
type MessageImage struct {
	MessageID int64  `gorm:"primaryKey;autoIncrement:false" json:"-"`
	Data      []byte `gorm:"type:longblob;not null" json:"-"`
	CreatedAt int64  `json:"-"`
}

// Temporary upload chunks survive requests/restarts; abandoned chunks expire.
type MessageImageChunk struct {
	UploadKey string `gorm:"primaryKey;size:64" json:"-"`
	Offset    int64  `gorm:"primaryKey;autoIncrement:false" json:"-"`
	Total     int64  `json:"-"`
	Data      []byte `gorm:"type:longblob;not null" json:"-"`
	CreatedAt int64  `gorm:"index" json:"-"`
}
