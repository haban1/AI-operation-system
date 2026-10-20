package model

// MomentContent stores durable asset IDs, never expiring WeChat upload responses.
type MomentContent struct {
	Content      string   `json:"content"`
	AssetIDs     []string `json:"asset_ids"`
	ShareType    string   `json:"share_type"`
	ShareWith    []string `json:"share_with"`
	DoNotShare   []string `json:"donot_share"`
	WithUserList []string `json:"with_user_list"`
}

type MomentPlan struct {
	ID             string        `gorm:"size:64;primaryKey" json:"id"`
	Fingerprint    string        `gorm:"size:64" json:"-"`
	Name           string        `gorm:"size:100" json:"name"`
	Kind           string        `gorm:"size:16" json:"kind"`
	Status         string        `gorm:"size:20;index" json:"status"`
	Topic          string        `gorm:"type:text" json:"topic"`
	Instructions   string        `gorm:"type:text" json:"instructions"`
	KnowledgeCodes []string      `gorm:"serializer:json;type:text" json:"knowledge_codes"`
	PublishMode    string        `gorm:"size:16" json:"publish_mode"`
	Repeat         string        `gorm:"size:16" json:"repeat"`
	Timezone       string        `gorm:"size:64" json:"timezone"`
	FirstRunAt     int64         `json:"first_run_at"`
	NextRunAt      int64         `gorm:"index" json:"next_run_at"`
	Payload        MomentContent `gorm:"serializer:json;type:longtext" json:"payload"`
	CreatedAt      int64         `json:"created_at"`
	UpdatedAt      int64         `json:"updated_at"`
}

type MomentPlanJob struct {
	ID           string        `gorm:"size:64;primaryKey" json:"id"`
	PlanID       string        `gorm:"size:64;uniqueIndex:moment_occurrence" json:"plan_id"`
	PlanName     string        `gorm:"size:100" json:"plan_name"`
	OccurrenceAt int64         `gorm:"uniqueIndex:moment_occurrence" json:"occurrence_at"`
	ScheduledAt  int64         `gorm:"index" json:"scheduled_at"`
	Status       string        `gorm:"size:24;index" json:"status"`
	Payload      MomentContent `gorm:"serializer:json;type:longtext" json:"payload"`
	Sources      string        `gorm:"type:text" json:"sources"`
	Error        string        `gorm:"type:text" json:"error"`
	MomentID     string        `gorm:"size:64" json:"moment_id"`
	CreatedAt    int64         `json:"created_at"`
	UpdatedAt    int64         `json:"updated_at"`
}

type MomentPlanAsset struct {
	ID        string `gorm:"size:64;primaryKey" json:"id"`
	Name      string `gorm:"size:255" json:"name"`
	MediaType string `gorm:"size:16" json:"media_type"`
	Size      int    `json:"size"`
	Data      []byte `gorm:"type:longblob" json:"-"`
	CreatedAt int64  `json:"created_at"`
}
