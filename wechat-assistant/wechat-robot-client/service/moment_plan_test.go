package service

import (
	"context"
	"encoding/json"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"wechat-robot-client/interface/ai"
	"wechat-robot-client/model"
	"wechat-robot-client/vars"
)

type momentKnowledgeStub struct {
	ai.KnowledgeService
	results []ai.VectorSearchResult
}

func (s momentKnowledgeStub) SearchKnowledgeByCategories(_ context.Context, _ string, codes []string, _ int) ([]ai.VectorSearchResult, error) {
	return s.results, nil
}

func TestMomentPlanUsesUnifiedModelAndRequiresKnowledgeEvidence(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	defer sqlDB.Close()
	oldDB, oldKnowledge := vars.DB, vars.KnowledgeService
	defer func() { vars.DB = oldDB; vars.KnowledgeService = oldKnowledge }()
	vars.DB = db
	if err = db.Exec("CREATE TABLE global_settings (id INTEGER PRIMARY KEY, chat_base_url TEXT, chat_api_key TEXT, chat_model TEXT)").Error; err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer test-internal-token" {
			t.Error("not using configured internal gateway token")
		}
		var body struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != "tianhe-robot-chat" || len(body.Messages) != 2 || !strings.Contains(body.Messages[1].Content, "真实业务资料") {
			t.Error("model or knowledge not passed")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"test","object":"chat.completion","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"**欢迎咨询**社区服务。"}}]}`))
	}))
	defer server.Close()
	if err = db.Exec("INSERT INTO global_settings VALUES (1,?,?,?)", server.URL, "test-internal-token", "tianhe-robot-chat").Error; err != nil {
		t.Fatal(err)
	}
	plan := model.MomentPlan{Topic: "社区服务", KnowledgeCodes: []string{"business"}}
	vars.KnowledgeService = momentKnowledgeStub{}
	if _, _, err = generateMomentPlanContent(context.Background(), plan); err == nil || calls != 0 {
		t.Fatal("generated without knowledge evidence")
	}
	vars.KnowledgeService = momentKnowledgeStub{results: []ai.VectorSearchResult{{Payload: map[string]string{"title": "服务说明", "content": "真实业务资料"}}}}
	text, sources, err := generateMomentPlanContent(context.Background(), plan)
	if err != nil || text != "欢迎咨询社区服务。" || sources != "服务说明" || calls != 1 {
		t.Fatal(text, sources, err, calls)
	}
}
