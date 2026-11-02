package repository

import (
	"errors"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
	"wechat-robot-client/model"
)

const MaxMessageImageSize int64 = 50 * 1024 * 1024

func (m *Message) GetImage(messageID int64) ([]byte, error) {
	var image model.MessageImage
	err := m.DB.WithContext(m.Ctx).Where("message_id = ?", messageID).Take(&image).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return image.Data, err
}

func (m *Message) SaveImage(messageID int64, data []byte) error {
	if messageID <= 0 || len(data) == 0 || int64(len(data)) > MaxMessageImageSize {
		return errors.New("无效的聊天图片")
	}
	return m.DB.WithContext(m.Ctx).Clauses(clause.OnConflict{DoNothing: true}).Create(&model.MessageImage{
		MessageID: messageID, Data: data, CreatedAt: time.Now().Unix(),
	}).Error
}

// Keep callback metadata without turning an already recorded send into a new turn.
func (m *Message) EnrichImageContent(message *model.Message) error {
	if message.MsgId == 0 || message.Type != model.MsgTypeImage || message.Content == "" {
		return nil
	}
	return m.DB.WithContext(m.Ctx).Model(&model.Message{}).
		Where("msg_id = ? AND type = ? AND from_wxid = ? AND sender_wxid = ? AND (content = '' OR content IS NULL)", message.MsgId, model.MsgTypeImage, message.FromWxID, message.SenderWxID).
		UpdateColumn("content", message.Content).Error
}

func (m *Message) SaveImageChunk(key string, offset, total int64, data []byte) error {
	if key == "" || offset < 0 || total <= 0 || total > MaxMessageImageSize || len(data) == 0 || offset+int64(len(data)) > total {
		return errors.New("图片分片大小无效")
	}
	db := m.DB.WithContext(m.Ctx)
	if offset == 0 {
		if err := db.Where("created_at < ?", time.Now().Add(-24*time.Hour).Unix()).Delete(&model.MessageImageChunk{}).Error; err != nil {
			return err
		}
	}
	return db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "upload_key"}, {Name: "offset"}}, DoUpdates: clause.AssignmentColumns([]string{"data", "total", "created_at"})}).Create(&model.MessageImageChunk{
		UploadKey: key, Offset: offset, Total: total, Data: data, CreatedAt: time.Now().Unix(),
	}).Error
}

func (m *Message) AssembleImageChunks(key string, total int64) ([]byte, error) {
	if total <= 0 || total > MaxMessageImageSize {
		return nil, errors.New("图片大小无效")
	}
	var chunks []model.MessageImageChunk
	if err := m.DB.WithContext(m.Ctx).Where("upload_key = ?", key).Order("`offset` ASC").Find(&chunks).Error; err != nil {
		return nil, err
	}
	var data []byte
	for _, chunk := range chunks {
		if chunk.Total != total || chunk.Offset != int64(len(data)) || int64(len(data)+len(chunk.Data)) > total {
			return nil, errors.New("图片分片不完整")
		}
		data = append(data, chunk.Data...)
	}
	if int64(len(data)) != total {
		return nil, errors.New("图片分片不完整")
	}
	return data, nil
}

func (m *Message) DeleteImageChunks(key string) error {
	return m.DB.WithContext(m.Ctx).Where("upload_key = ?", key).Delete(&model.MessageImageChunk{}).Error
}
