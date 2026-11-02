package service

import (
	"context"
	"log"
	"time"
	"wechat-robot-client/pkg/robot"
	"wechat-robot-client/repository"
	"wechat-robot-client/vars"
)

// Delivery has already succeeded: persistence failures must never request a resend.
// Finish recording even if the browser disconnects after WeChat accepted the send.
func (s *MessageService) saveSentImage(messageID int64, data []byte) {
	if messageID <= 0 {
		return
	}
	_, extension := (&robot.Robot{}).DetectImageType(data)
	if extension == "" {
		log.Printf("[ChatImage] unsupported image for message %d", messageID)
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(s.ctx), 20*time.Second)
	defer cancel()
	if err := repository.NewMessageRepo(ctx, vars.DB).SaveImage(messageID, data); err != nil {
		log.Printf("[ChatImage] save message %d: %v", messageID, err)
	}
}
