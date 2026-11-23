package openaitools

import (
	"context"
	"github.com/openai/openai-go/v3"
	"net/http"
	"net/http/httptest"
	"testing"
	"wechat-robot-client/pkg/robotctx"
	"wechat-robot-client/pkg/tianheknowledge"
)

func TestSharedKnowledgeWorksWithoutNativeRAGOrBindings(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ANSWERED","text":"统一主知识库答复"}`))
	}))
	defer srv.Close()
	rc := &robotctx.RobotContext{RobotID: 5, RobotCode: "test", FromWxID: "friend-test", MessageID: 1}
	tianheknowledge.Prepare(rc, srv.URL+"/api/model/v1", "test", []openai.ChatCompletionMessageParamUnion{openai.UserMessage("公司简介")})
	tool := NewSearchKnowledgeTool(nil)
	if tool.GetOpenAITool(rc) == nil {
		t.Fatal("tool hidden when native RAG is nil")
	}
	got, immediate, err := tool.ExecuteToolCall(context.Background(), rc, openai.ChatCompletionMessageToolCallUnion{})
	if err != nil || !immediate || got != "统一主知识库答复" {
		t.Fatalf("not returned directly: %q %t %v", got, immediate, err)
	}
	rc.KnowledgeAPIKey = ""
	got, immediate, err = tool.ExecuteToolCall(context.Background(), rc, openai.ChatCompletionMessageToolCallUnion{})
	if err != nil || !immediate || got != tianheknowledge.Unavailable {
		t.Fatal("shared failure allowed native fallback or generation")
	}
}
