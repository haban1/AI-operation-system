package tianheknowledge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openai/openai-go/v3"
	"wechat-robot-client/pkg/robotctx"
)

func TestPrepareScopesTextAndCapsHistory(t *testing.T) {
	rc := &robotctx.RobotContext{}
	msgs := []openai.ChatCompletionMessageParamUnion{openai.SystemMessage("other group member private content")}
	for range 5 {
		msgs = append(msgs, openai.UserMessage("之前的问题"), openai.AssistantMessage("之前的回答"))
	}
	msgs = append(msgs, openai.ToolMessage("not user history", "call-1"), openai.UserMessage("那具体业务呢"))
	Prepare(rc, "http://web:3100/api/model/v1/", "internal-test", msgs)
	if rc.KnowledgeQuery != "那具体业务呢" || len(rc.KnowledgeHistory) != 6 {
		t.Fatalf("incorrect scoped history: %+v", rc.KnowledgeHistory)
	}
	for _, msg := range rc.KnowledgeHistory {
		if strings.Contains(msg.Text, "private") || strings.Contains(msg.Text, "not user") {
			t.Fatal("leaked non-conversation content")
		}
	}
	for _, base := range []string{"https://api.test/v1", "http://web:3100/api/model/v1?x=1", "http://user:pw@web/api/model/v1"} {
		if GatewayURL(base) != "" {
			t.Fatalf("enabled for invalid gateway %s", base)
		}
	}
	Prepare(rc, "https://provider.test/v1", "external", msgs)
	if rc.KnowledgeBaseURL != "" || rc.KnowledgeQuery != "" || len(rc.KnowledgeHistory) != 0 {
		t.Fatal("native mode retained shared context")
	}
}

func TestQueryIdentityAndFailureHandling(t *testing.T) {
	var calls []map[string]any
	replyKind := ""
	status, text, httpStatus := "ANSWERED", "经校验的公司介绍", 200
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/model/v1/knowledge/query" || r.Header.Get("Authorization") != "Bearer internal-test" {
			t.Error("incorrect endpoint/authentication")
		}
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, body)
		w.WriteHeader(httpStatus)
		json.NewEncoder(w).Encode(map[string]string{"status": status, "text": text, "replyKind": replyKind})
	}))
	defer srv.Close()
	rc := &robotctx.RobotContext{RobotID: 5, RobotCode: "robot-test", RobotWxID: "self-test", FromWxID: "room-one@chatroom", SenderWxID: "member-one", MessageID: 12}
	Prepare(rc, srv.URL+"/api/model/v1", "internal-test", []openai.ChatCompletionMessageParamUnion{openai.UserMessage("公司简介")})
	got, err := Query(context.Background(), rc)
	if err != nil || got != text {
		t.Fatalf("answer: %q, %v", got, err)
	}
	first := calls[0]
	if first["text"] != "公司简介" || len(first["accountId"].(string)) != 64 || len(first["conversationId"].(string)) != 64 {
		t.Fatal("invalid query identity")
	}
	for _, change := range []func(){func() { rc.SenderWxID = "member-two" }, func() { rc.FromWxID = "room-two@chatroom" }, func() { rc.FromWxID = "friend-two" }} {
		change()
		Query(context.Background(), rc)
		if calls[len(calls)-1]["conversationId"] == first["conversationId"] {
			t.Fatal("conversation identity collision")
		}
	}
	status, text = "NO_ANSWER", "untrusted provider error"
	got, err = Query(context.Background(), rc)
	if err != nil || got != "这个问题建议向人工客服咨询一下。" {
		t.Fatal("no-answer not handled safely")
	}
	for _, item := range []struct {
		status, kind, text string
		valid              bool
	}{
		{"NO_ANSWER", "CONSULTATION", "报名方式可以向人工客服咨询一下。", true},
		{"SOCIAL_REPLY", "SOCIAL", "哈哈，谢谢认可～", true},
		{"NEED_CLARIFICATION", "CLARIFICATION", "你想参加哪个活动或课程呀？", true},
		{"NEED_CLARIFICATION", "HUMAN_GUIDANCE", "请联系人工客服", true},
		{"SOCIAL_REPLY", "CONSULTATION", "不匹配", false},
		{"NEED_CLARIFICATION", "SOCIAL", "不匹配", false},
		{"SOCIAL_REPLY", "SOCIAL", "", false},
		{"SOCIAL_REPLY", "SOCIAL", strings.Repeat("字", 601), false},
	} {
		status, replyKind, text = item.status, item.kind, item.text
		got, err = Query(context.Background(), rc)
		if item.valid && (err != nil || got != text) {
			t.Fatalf("presentation %s/%s: %q %v", status, replyKind, got, err)
		}
		if !item.valid && err == nil {
			t.Fatalf("accepted invalid presentation %s/%s", status, replyKind)
		}
	}
	replyKind = ""
	for _, invalid := range []string{"UNAVAILABLE", "UNKNOWN", ""} {
		status = invalid
		if _, err = Query(context.Background(), rc); err == nil {
			t.Fatal("accepted invalid result")
		}
	}
	status = "ANSWERED"
	text = ""
	if _, err = Query(context.Background(), rc); err == nil {
		t.Fatal("accepted empty answer")
	}
	httpStatus = 503
	if _, err = Query(context.Background(), rc); err == nil {
		t.Fatal("accepted failed HTTP")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = Query(ctx, rc); err == nil {
		t.Fatal("ignored cancellation")
	}
	rc.FromWxID = "room@chatroom"
	rc.SenderWxID = ""
	if _, err = Query(context.Background(), rc); err == nil {
		t.Fatal("missing group member accepted")
	}
}
