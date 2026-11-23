package tianheknowledge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/openai/openai-go/v3"
	"wechat-robot-client/pkg/robotctx"
)

const Unavailable = "知识库暂时无法查询，请稍后再试。"

// Enable only for Tianhe's internal gateway, reusing its existing credential.
func GatewayURL(base string) string {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(base), "/"))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		(u.Scheme != "http" && u.Scheme != "https") || u.Path != "/api/model/v1" {
		return ""
	}
	return u.String()
}

// Prepare takes only the caller's conversation messages, before group/system
// context is added. The existing repository scopes group history by room/member.
func Prepare(rc *robotctx.RobotContext, base, key string, messages []openai.ChatCompletionMessageParamUnion) {
	rc.KnowledgeBaseURL = GatewayURL(base)
	rc.KnowledgeAPIKey = key
	rc.KnowledgeQuery = ""
	rc.KnowledgeHistory = nil
	if rc.KnowledgeBaseURL == "" {
		return
	}
	var pending string
	for _, msg := range messages {
		if msg.OfUser != nil {
			pending = messageText(msg)
			rc.KnowledgeQuery = pending
		} else if msg.OfAssistant != nil && len(msg.OfAssistant.ToolCalls) == 0 {
			text := messageText(msg)
			if pending != "" && text != "" && len([]rune(pending)) <= 4000 && len([]rune(text)) <= 4000 {
				rc.KnowledgeHistory = append(rc.KnowledgeHistory,
					robotctx.KnowledgeMessage{Role: "USER", Text: pending},
					robotctx.KnowledgeMessage{Role: "ASSISTANT", Text: text})
			}
			pending = ""
		}
	}
	for len(rc.KnowledgeHistory) > 0 {
		total := 0
		for _, msg := range rc.KnowledgeHistory {
			total += len([]rune(msg.Text))
		}
		if len(rc.KnowledgeHistory) <= 6 && total <= 12000 {
			break
		}
		rc.KnowledgeHistory = rc.KnowledgeHistory[2:]
	}
}

func messageText(msg openai.ChatCompletionMessageParamUnion) string {
	// Marshal only the selected conversation message; image URLs/audio and tool
	// results are intentionally excluded from grounded text history.
	b, err := json.Marshal(msg)
	if err != nil {
		return ""
	}
	var raw struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return ""
	}
	var text string
	if json.Unmarshal(raw.Content, &text) == nil {
		return strings.TrimSpace(text)
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw.Content, &parts) != nil {
		return ""
	}
	var lines []string
	for _, part := range parts {
		if part.Type == "text" {
			lines = append(lines, part.Text)
		}
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

func hash(parts ...string) string {
	b, _ := json.Marshal(parts)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func Query(ctx context.Context, rc *robotctx.RobotContext) (string, error) {
	if GatewayURL(rc.KnowledgeBaseURL) == "" || rc.KnowledgeAPIKey == "" || rc.FromWxID == "" ||
		(strings.HasSuffix(rc.FromWxID, "@chatroom") && rc.SenderWxID == "") || strings.TrimSpace(rc.KnowledgeQuery) == "" {
		return "", fmt.Errorf("shared knowledge configuration or conversation is incomplete")
	}
	payload := struct {
		Text           string                      `json:"text"`
		AccountID      string                      `json:"accountId"`
		ConversationID string                      `json:"conversationId"`
		MessageID      string                      `json:"messageId"`
		Context        []robotctx.KnowledgeMessage `json:"context"`
	}{
		Text:           rc.KnowledgeQuery,
		AccountID:      hash(rc.RobotCode, strconv.FormatInt(rc.RobotID, 10), rc.RobotWxID),
		ConversationID: hash(rc.FromWxID, rc.SenderWxID),
		MessageID:      strconv.FormatInt(rc.MessageID, 10),
		Context:        append([]robotctx.KnowledgeMessage{}, rc.KnowledgeHistory...),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode shared knowledge request")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(queryCtx, http.MethodPost, rc.KnowledgeBaseURL+"/knowledge/query", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create shared knowledge request")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+rc.KnowledgeAPIKey)
	client := &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("shared knowledge connection failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("shared knowledge HTTP %d", res.StatusCode)
	}
	var result struct {
		Status    string `json:"status"`
		Text      string `json:"text"`
		ReplyKind string `json:"replyKind"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 64*1024)).Decode(&result) != nil {
		return "", fmt.Errorf("invalid shared knowledge response")
	}
	if result.Status == "NO_ANSWER" {
		if result.ReplyKind == "CONSULTATION" && strings.TrimSpace(result.Text) != "" && len([]rune(result.Text)) <= 600 {
			return strings.TrimSpace(result.Text), nil
		}
		return "这个问题建议向人工客服咨询一下。", nil
	}
	if (result.Status == "SOCIAL_REPLY" && result.ReplyKind == "SOCIAL") ||
		(result.Status == "NEED_CLARIFICATION" && (result.ReplyKind == "CLARIFICATION" || result.ReplyKind == "HUMAN_GUIDANCE")) {
		if strings.TrimSpace(result.Text) == "" || len([]rune(result.Text)) > 600 {
			return "", fmt.Errorf("invalid shared conversation response")
		}
		return strings.TrimSpace(result.Text), nil
	}
	if result.Status != "ANSWERED" || strings.TrimSpace(result.Text) == "" || len([]rune(result.Text)) > 4000 {
		return "", fmt.Errorf("shared knowledge unavailable")
	}
	return strings.TrimSpace(result.Text), nil
}
