package momentplan

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	_ "time/tzdata"
	"unicode/utf8"
	"wechat-robot-client/model"
)

var requestID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,64}$`)

type CreateRequest struct {
	ID             string              `json:"id"`
	Name           string              `json:"name"`
	Kind           string              `json:"kind"`
	Topic          string              `json:"topic"`
	Instructions   string              `json:"instructions"`
	KnowledgeCodes []string            `json:"knowledge_codes"`
	PublishMode    string              `json:"publish_mode"`
	Repeat         string              `json:"repeat"`
	Timezone       string              `json:"timezone"`
	FirstRunAt     int64               `json:"first_run_at"`
	Payload        model.MomentContent `json:"payload"`
}

func validateCreate(r *CreateRequest, now int64) error {
	r.Name = strings.TrimSpace(r.Name)
	r.Topic = strings.TrimSpace(r.Topic)
	r.Payload.Content = strings.TrimSpace(r.Payload.Content)
	if !requestID.MatchString(r.ID) || r.Name == "" || utf8.RuneCountInString(r.Name) > 100 {
		return errors.New("请填写计划名称（最多100字）和有效请求编号")
	}
	if r.FirstRunAt <= now || r.FirstRunAt > now+366*86400 {
		return errors.New("请选择未来一年内的首次发布时间")
	}
	if _, err := time.LoadLocation(r.Timezone); err != nil {
		return errors.New("时区无效")
	}
	if !slices.Contains([]string{"once", "daily", "weekly"}, r.Repeat) {
		return errors.New("执行频率无效")
	}
	if !slices.Contains([]string{"review", "auto"}, r.PublishMode) {
		return errors.New("发布方式无效")
	}
	if r.Kind == "manual" {
		if r.Repeat != "once" || r.PublishMode != "auto" {
			return errors.New("定时发布仅支持单次执行")
		}
	} else if r.Kind == "ai" {
		if r.Topic == "" || utf8.RuneCountInString(r.Topic) > 500 || utf8.RuneCountInString(r.Instructions) > 2000 || len(r.KnowledgeCodes) > 20 {
			return errors.New("请填写主题（最多500字），写作要求最多2000字，知识库最多20个")
		}
		r.Payload.Content = ""
	} else {
		return errors.New("计划类型无效")
	}
	return validateContent(r.Payload, r.Kind == "ai")
}

func validateContent(p model.MomentContent, allowEmpty bool) error {
	if utf8.RuneCountInString(p.Content) > 2000 || (!allowEmpty && strings.TrimSpace(p.Content) == "" && len(p.AssetIDs) == 0) {
		return errors.New("内容不能为空，正文最多2000字")
	}
	if len(p.AssetIDs) > 9 {
		return errors.New("最多9张图片或1个视频")
	}
	if !slices.Contains([]string{"public", "private", "share_with", "donot_share"}, p.ShareType) {
		return errors.New("可见范围无效")
	}
	if p.ShareType == "share_with" && len(p.ShareWith) == 0 {
		return errors.New("请选择可见好友")
	}
	if p.ShareType == "donot_share" && len(p.DoNotShare) == 0 {
		return errors.New("请选择不可见好友")
	}
	for _, list := range [][]string{p.ShareWith, p.DoNotShare, p.WithUserList} {
		if len(list) > 500 {
			return errors.New("名单最多500人")
		}
		for _, id := range list {
			if strings.TrimSpace(id) == "" || strings.Contains(id, ",") {
				return errors.New("好友标识无效")
			}
		}
	}
	for _, id := range p.WithUserList {
		if p.ShareType == "share_with" && !slices.Contains(p.ShareWith, id) {
			return errors.New("提醒好友必须在可见范围内")
		}
		if p.ShareType == "donot_share" && slices.Contains(p.DoNotShare, id) {
			return errors.New("提醒好友不能在不可见名单中")
		}
	}
	return nil
}

// NextOccurrence preserves wall-clock time in the chosen zone, including DST.
func NextOccurrence(at, after int64, repeat, zone string) (int64, error) {
	if repeat == "once" {
		return 0, nil
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return 0, err
	}
	days := 1
	if repeat == "weekly" {
		days = 7
	} else if repeat != "daily" {
		return 0, fmt.Errorf("无效频率")
	}
	t := time.Unix(at, 0).In(loc)
	for t.Unix() <= after {
		t = t.AddDate(0, 0, days)
	}
	return t.Unix(), nil
}
