package controller

import (
	"encoding/json"
	"errors"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/appx"
	"wechat-robot-client/pkg/support"
)

type Support struct{}

func (s *Support) State(c *gin.Context) {
	data, err := support.Default.Snapshot()
	s.respond(c, data, err)
}
func (s *Support) Settings(c *gin.Context) {
	var req model.SupportSettings
	if err := c.ShouldBindJSON(&req); err != nil {
		s.respond(c, nil, errors.New("设置格式无效"))
		return
	}
	s.respond(c, nil, support.Default.SaveSettings(req))
}
func (s *Support) Reception(c *gin.Context) {
	var req struct {
		Peer   string `json:"peer"`
		Room   string `json:"room"`
		Active *bool  `json:"active"`
		Reason string `json:"reason"`
	}
	if c.ShouldBindJSON(&req) != nil || req.Active == nil || (req.Room == "" && !support.Default.IsFriend(req.Peer)) {
		s.respond(c, nil, errors.New("请选择有效好友和接待状态"))
		return
	}
	var err error
	if *req.Active {
		err = support.Default.Takeover(req.Peer, req.Room, req.Reason)
	} else {
		_, _, err = support.Default.Transition(req.Peer, req.Room, false, "")
	}
	s.respond(c, nil, err)
}
func (s *Support) Broadcast(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 12*1024*1024)
	if err := c.Request.ParseMultipartForm(12 * 1024 * 1024); err != nil {
		s.respond(c, nil, errors.New("请求过大或群发内容格式无效"))
		return
	}
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	var peers []string
	if json.Unmarshal([]byte(c.PostForm("recipients")), &peers) != nil {
		s.respond(c, nil, errors.New("好友列表格式无效"))
		return
	}
	var image []byte
	file, _, err := c.Request.FormFile("image")
	if err == nil {
		defer file.Close()
		image, err = io.ReadAll(io.LimitReader(file, 10*1024*1024+1))
		if err != nil {
			s.respond(c, nil, err)
			return
		}
	} else if !errors.Is(err, http.ErrMissingFile) {
		s.respond(c, nil, err)
		return
	}
	job, err := support.Default.Submit(c.PostForm("client_request_id"), c.PostForm("content"), peers, image, c.PostForm("confirm_send") == "true")
	s.respond(c, job, err)
}
func (s *Support) respond(c *gin.Context, data any, err error) {
	r := appx.NewResponse(c)
	if err != nil {
		r.ToErrorResponse(err)
	} else {
		r.ToResponse(data)
	}
}
