package startup

import (
	"context"
	"os"
	"wechat-robot-client/pkg/support"
	"wechat-robot-client/service"
	"wechat-robot-client/vars"
)

func InitSupport() error {
	m := support.New(vars.DB)
	m.SendText = func(peer, text string, at ...string) error {
		return service.NewMessageService(context.Background()).SendTextMessage(peer, text, at...)
	}
	m.SendImage = func(peer string, data []byte) error {
		f, err := os.CreateTemp("", "robot-broadcast-*")
		if err != nil {
			return err
		}
		defer os.Remove(f.Name())
		defer f.Close()
		if _, err = f.Write(data); err != nil {
			return err
		}
		if _, err = f.Seek(0, 0); err != nil {
			return err
		}
		_, err = service.NewMessageService(context.Background()).MsgUploadImg(peer, f)
		return err
	}
	support.Default = m
	return m.Start(context.Background())
}
