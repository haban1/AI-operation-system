package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"wechat-robot-client/model"
)

func TestMomentAutoInteractionPolicy(t *testing.T) {
	tests := []struct {
		name, reply                                  string
		autoLike, autoComment, wantLike, wantComment bool
	}{
		{"happy like only", `{"like":"yes","comment":"yes"}`, true, false, true, false},
		{"sad can comment but must not like", `{"like":"no","comment":"yes"}`, true, false, false, false},
		{"like does not depend on comments", `{"like":"yes","comment":"no"}`, true, true, true, false},
		{"condolences", `{"like":"no","comment":"no"}`, true, true, false, false},
		{"manual only", `{"like":"yes","comment":"yes"}`, false, false, false, false},
		{"missing decision", `{"like":"yes"}`, true, true, false, false},
		{"invalid decision", `{"like":"yes","comment":"maybe"}`, true, true, false, false},
		{"malformed response", `not JSON`, true, true, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Stream         bool `json:"stream"`
					ResponseFormat struct {
						Type string `json:"type"`
					} `json:"response_format"`
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				if body.ResponseFormat.Type != "json_object" || !body.Stream || len(body.Messages) < 2 || !strings.Contains(body.Messages[0].Content, "JSON") {
					t.Error("request must use supported JSON mode with explicit output instructions")
					w.WriteHeader(400)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				content, _ := json.Marshal(tt.reply)
				fmt.Fprintf(w, "data: {\"id\":\"mock\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"mock\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":%s},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", content)
			}))
			defer server.Close()
			settings := &model.MomentSettings{AIBaseURL: server.URL, AIAPIKey: "mock", WorkflowModel: "mock", AutoLike: &tt.autoLike, AutoComment: &tt.autoComment}
			mood := NewAIMomentService(context.Background()).GetMomentMood("模拟动态，不发送微信", *settings)
			like, comment := allowedMomentActions(settings, mood)
			if like != tt.wantLike || comment != tt.wantComment {
				t.Fatalf("like/comment = %v/%v, want %v/%v", like, comment, tt.wantLike, tt.wantComment)
			}
		})
	}
}
