package controller

import (
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httputil"
	"net/url"
	"time"
	"wechat-robot-admin-backend/pkg/appx"
)

// SupportProxy is only registered on owner-authenticated, explicit routes.
func SupportProxy(c *gin.Context) {
	robot, err := appx.GetRobot(c)
	if err != nil {
		appx.NewResponse(c).ToErrorResponse(errors.New("无法获取机器人"))
		return
	}
	suffix := ""
	switch c.FullPath() {
	case "/api/v1/support":
	case "/api/v1/support/settings":
		suffix = "/settings"
	case "/api/v1/support/reception":
		suffix = "/reception"
	case "/api/v1/support/broadcasts":
		suffix = "/broadcasts"
	default:
		c.AbortWithStatus(404)
		return
	}
	target, err := url.Parse(robot.GetBaseURL())
	if err != nil {
		c.AbortWithStatus(502)
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 12*1024*1024)
	proxy := httputil.NewSingleHostReverseProxy(target)
	original := proxy.Director
	proxy.Director = func(r *http.Request) {
		original(r)
		r.URL.Path = target.Path + "/support" + suffix
		r.URL.RawQuery = ""
		r.Header.Del("Cookie")
		r.Header.Del("Authorization")
	}
	proxy.Transport = &http.Transport{ResponseHeaderTimeout: 65 * time.Second}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		appx.NewResponse(c).ToErrorResponse(errors.New("机器人服务不可用；群发提交结果未确认时，请先核对记录"))
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}
