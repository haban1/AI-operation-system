package controller

import (
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
	"wechat-robot-admin-backend/pkg/appx"
)

var momentPlanTransport = &http.Transport{ResponseHeaderTimeout: 90 * time.Second}

// MomentPlanProxy is mounted only on explicit, owner-authorized routes.
func MomentPlanProxy(c *gin.Context) {
	robot, err := appx.GetRobot(c)
	if err != nil {
		appx.NewResponse(c).ToErrorResponse(errors.New("无法获取机器人"))
		return
	}
	switch c.FullPath() {
	case "/api/v1/moments/plans", "/api/v1/moments/plans/action", "/api/v1/moments/plan-jobs/action", "/api/v1/moments/plan-assets":
	default:
		c.AbortWithStatus(404)
		return
	}
	target, err := url.Parse(robot.GetBaseURL())
	if err != nil {
		c.AbortWithStatus(502)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32*1024*1024)
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.URL.Path = target.Path + strings.TrimPrefix(c.FullPath(), "/api/v1")
		r.URL.RawQuery = ""
		r.Header.Del("Cookie")
		r.Header.Del("Authorization")
	}
	proxy.Transport = momentPlanTransport
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
		appx.NewResponse(c).ToErrorResponse(errors.New("机器人服务暂不可用，请刷新计划记录确认提交结果"))
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}
