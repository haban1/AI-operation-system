package service

import (
	"context"
	"errors"
	"log"

	"wechat-robot-client/model"
	"wechat-robot-client/pkg/session"
	"wechat-robot-client/repository"
	"wechat-robot-client/vars"
)

func NewLoginSession(ctx context.Context) (*session.Manager, error) {
	r := vars.RobotRuntime
	store := repository.NewLoginSessionRepo(vars.RedisClient, r.RobotID)
	stopped, err := store.Stopped(ctx)
	if err != nil {
		return nil, err
	}
	return session.New(session.Hooks{
		Probe: func(ctx context.Context) error {
			if r.WxID == "" {
				return errors.New("微信尚未登录")
			}
			_, err := r.Client.GetProfileContext(ctx, r.WxID)
			return err
		},
		StartHeartbeat: func(ctx context.Context) error {
			if r.WxID == "" {
				return nil
			}
			return r.Client.AutoHeartBeatContext(ctx, r.WxID)
		},
		StopHeartbeat: func(ctx context.Context) error {
			if r.WxID == "" {
				return nil
			}
			return r.Client.CloseAutoHeartBeatContext(ctx, r.WxID)
		},
		Logout: func(ctx context.Context) error {
			if r.WxID == "" {
				return nil
			}
			return r.Client.LogoutContext(ctx, r.WxID)
		},
		SaveStopped: store.SaveStopped,
		Online: func(ctx context.Context) error {
			if err := repository.NewRobotAdminRepo(ctx, vars.AdminDB).Update(&model.RobotAdmin{
				ID: r.RobotID, Status: model.RobotStatusOnline,
			}); err != nil {
				return err
			}
			r.Status = model.RobotStatusOnline
			if vars.CronManager != nil {
				vars.CronManager.Clear()
				vars.CronManager.Start()
			}
			if r.SyncMomentCancel != nil {
				r.SyncMomentCancel()
			}
			// Create the cancellation context before starting the goroutine so a
			// concurrent disconnect cannot leave a delayed worker running.
			r.SyncMomentContext, r.SyncMomentCancel = context.WithCancel(context.Background())
			go NewMomentsService(r.SyncMomentContext).SyncMomentStart()
			log.Println("[微信会话] 登录状态已恢复，自动心跳和后台任务已启用")
			return nil
		},
		Offline: func(ctx context.Context) error {
			wasOnline := r.Status == model.RobotStatusOnline
			r.Status = model.RobotStatusOffline
			if r.SyncMomentCancel != nil {
				r.SyncMomentCancel()
			}
			if vars.CronManager != nil {
				vars.CronManager.Clear()
			}
			if wasOnline {
				log.Println("[微信会话] 客户端标记离线，协议层心跳重试由登录意图控制")
			}
			return repository.NewRobotAdminRepo(ctx, vars.AdminDB).Update(&model.RobotAdmin{
				ID: r.RobotID, Status: model.RobotStatusOffline,
			})
		},
	}, stopped), nil
}
