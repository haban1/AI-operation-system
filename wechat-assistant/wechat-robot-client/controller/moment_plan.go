package controller

import (
	"errors"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"time"
	"wechat-robot-client/pkg/appx"
	"wechat-robot-client/pkg/momentplan"
)

// MomentPlans only handles transport; persistence and dispatch live in momentplan.
func MomentPlans(c *gin.Context) {
	r := appx.NewResponse(c)
	m := momentplan.Default
	if m == nil {
		r.ToErrorResponse(errors.New("朋友圈计划服务尚未就绪"))
		return
	}
	var data any
	var err error
	if c.Request.Method == http.MethodGet {
		data, err = m.Store.Snapshot()
	} else {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32*1024*1024)
		switch c.FullPath() {
		case "/api/v1/robot/moments/plans":
			var req momentplan.CreateRequest
			if err = c.ShouldBindJSON(&req); err == nil {
				data, err = m.Store.Create(req, time.Now().Unix())
			}
		case "/api/v1/robot/moments/plans/action":
			var req struct {
				PlanID string `json:"plan_id"`
				Action string `json:"action"`
			}
			if err = c.ShouldBindJSON(&req); err == nil {
				err = m.Store.PlanAction(req.PlanID, req.Action, time.Now().Unix())
			}
		case "/api/v1/robot/moments/plan-jobs/action":
			var req momentplan.JobActionRequest
			if err = c.ShouldBindJSON(&req); err == nil {
				err = m.Store.JobAction(req, time.Now().Unix())
			}
		case "/api/v1/robot/moments/plan-assets":
			file, header, e := c.Request.FormFile("media")
			if c.Request.MultipartForm != nil {
				defer c.Request.MultipartForm.RemoveAll()
			}
			if e != nil {
				err = errors.New("请选择附件，图片最大10MB，视频最大30MB")
				break
			}
			defer file.Close()
			var body []byte
			body, err = io.ReadAll(io.LimitReader(file, 30*1024*1024+1))
			if err == nil {
				data, err = m.Store.SaveAsset(header.Filename, body)
			}
		default:
			err = errors.New("不支持的操作")
		}
	}
	if err != nil {
		r.ToErrorResponse(err)
	} else {
		r.ToResponse(data)
	}
}
