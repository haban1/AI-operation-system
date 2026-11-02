package repository

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// LoginSession keeps deliberate logout separate from temporary offline status.
type LoginSession struct {
	client *redis.Client
	key    string
}

func NewLoginSessionRepo(client *redis.Client, robotID int64) *LoginSession {
	return &LoginSession{client: client, key: fmt.Sprintf("robot:session:manual_logout:%d", robotID)}
}

func (r *LoginSession) Stopped(ctx context.Context) (bool, error) {
	value, err := r.client.Get(ctx, r.key).Result()
	if err == redis.Nil {
		return false, nil
	}
	return value == "1", err
}

func (r *LoginSession) SaveStopped(ctx context.Context, stopped bool) error {
	if stopped {
		return r.client.Set(ctx, r.key, "1", 0).Err()
	}
	return r.client.Del(ctx, r.key).Err()
}
