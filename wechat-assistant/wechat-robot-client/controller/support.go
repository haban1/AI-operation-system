package controller

import (
	"encoding/json"
	"errors"
	"github.com/gin-gonic/gin"
	"io"
	"mime/multipart"
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
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, support.MaxBroadcastRequestBytes)
	parseErr := c.Request.ParseMultipartForm(1024 * 1024)
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if parseErr != nil {
		s.respond(c, nil, errors.New("请求过大或群发内容格式无效（最多 3 张图片，每张最大 10 MB）"))
		return
	}
	var peers []string
	if json.Unmarshal([]byte(c.PostForm("recipients")), &peers) != nil {
		s.respond(c, nil, errors.New("好友列表格式无效"))
		return
	}
	images, err := readBroadcastImages(c.Request.MultipartForm)
	if err != nil {
		s.respond(c, nil, err)
		return
	}
	job, err := support.Default.SubmitImages(c.PostForm("client_request_id"), c.PostForm("content"), peers, images, c.PostForm("confirm_send") == "true")
	s.respond(c, job, err)
}

func readBroadcastImages(form *multipart.Form) ([][]byte, error) {
	var images [][]byte
	count := 0
	for field, files := range form.File {
		if field != "image" && field != "image2" && field != "image3" {
			return nil, errors.New("图片上传字段无效")
		}
		count += len(files)
	}
	if count > support.MaxBroadcastImages {
		return nil, errors.New("一次最多发送 3 张图片")
	}
	for _, field := range []string{"image", "image2", "image3"} {
		for _, header := range form.File[field] {
			if header.Size == 0 || header.Size > support.MaxBroadcastImageBytes {
				return nil, errors.New("每张图片不能为空且不能超过 10 MB")
			}
			file, err := header.Open()
			if err != nil {
				return nil, err
			}
			image, err := io.ReadAll(io.LimitReader(file, support.MaxBroadcastImageBytes+1))
			file.Close()
			if err != nil {
				return nil, err
			}
			images = append(images, image)
		}
	}
	return images, nil
}
func (s *Support) respond(c *gin.Context, data any, err error) {
	r := appx.NewResponse(c)
	if err != nil {
		r.ToErrorResponse(err)
	} else {
		r.ToResponse(data)
	}
}
