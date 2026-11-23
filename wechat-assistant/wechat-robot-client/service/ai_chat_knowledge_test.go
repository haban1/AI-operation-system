package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/openai/openai-go/v3"
	"wechat-robot-client/model"
	"wechat-robot-client/pkg/robotctx"
	"wechat-robot-client/vars"
)

func TestAIChatUsesSharedKnowledgeAndReturnsValidatedAnswerDirectly(t *testing.T) {
	modelCalls, knowledgeCalls := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer internal-test" {
			t.Error("missing internal authentication")
		}
		switch r.URL.Path {
		case "/api/model/v1/chat/completions":
			modelCalls++
			var data struct {
				Tools []struct {
					Function struct {
						Name string `json:"name"`
					} `json:"function"`
				} `json:"tools"`
			}
			json.NewDecoder(r.Body).Decode(&data)
			found := false
			for _, tool := range data.Tools {
				if tool.Function.Name == "search_document" {
					found = true
				}
			}
			if !found {
				t.Error("shared knowledge tool not offered")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: {\"id\":\"chat-test\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"type\":\"function\",\"function\":{\"name\":\"search_document\",\"arguments\":\"{\\\"query\\\":\\\"wrong rewritten question\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n")
		case "/api/model/v1/knowledge/query":
			knowledgeCalls++
			var data struct {
				Text    string                      `json:"text"`
				Context []robotctx.KnowledgeMessage `json:"context"`
			}
			json.NewDecoder(r.Body).Decode(&data)
			if data.Text != "公司主要做什么" || len(data.Context) != 2 {
				t.Error("lost original question or paired context")
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"ANSWERED","text":"知识库已校验的准确答复"}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	previous := vars.Agent
	defer func() { vars.Agent = previous }()
	agent := NewAgentService(context.Background(), nil, nil)
	agent.internalToolsManager.Initialize()
	vars.Agent = agent
	config := &FriendSettingsService{globalSettings: &model.GlobalSettings{ChatBaseURL: srv.URL + "/api/model/v1", ChatAPIKey: "internal-test", ChatModel: "tianhe-robot-chat"}}
	chat := NewAIChatService(context.Background(), config)
	reply, err := chat.Chat(robotctx.RobotContext{RobotID: 5, FromWxID: "friend-test", MessageID: 3}, []openai.ChatCompletionMessageParamUnion{
		openai.UserMessage("介绍公司"), openai.AssistantMessage("之前的介绍"), openai.UserMessage("公司主要做什么"),
	})
	if err != nil || reply.Content != "知识库已校验的准确答复" || modelCalls != 1 || knowledgeCalls != 1 {
		t.Fatalf("incorrect flow: model=%d knowledge=%d error=%v", modelCalls, knowledgeCalls, err)
	}
}
