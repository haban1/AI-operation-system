package controller

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"wechat-robot-client/pkg/support"
)

func (s *Support) BroadcastDetail(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	data, err := support.Default.BroadcastDetails(c.Query("broadcast_id"))
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = errors.New("群发记录不存在")
	}
	s.respond(c, data, err)
}

func (s *Support) BroadcastImage(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
	c.Header("X-Content-Type-Options", "nosniff")
	position, err := strconv.Atoi(c.Query("position"))
	if err != nil || position < 1 || position > support.MaxBroadcastImages {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	image, mime, err := support.Default.BroadcastImage(c.Query("broadcast_id"), position)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.AbortWithStatus(http.StatusNotFound)
		} else {
			c.AbortWithStatus(http.StatusBadRequest)
		}
		return
	}
	c.Data(http.StatusOK, mime, image)
}
