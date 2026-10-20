package openaitools

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/openai/openai-go/v3"
	"strings"
	"wechat-robot-client/pkg/robotctx"
	"wechat-robot-client/pkg/support"
	"wechat-robot-client/vars"
)

type HumanHandoffTool struct{}

func (t *HumanHandoffTool) GetOpenAITool(rc *robotctx.RobotContext) *openai.ChatCompletionToolUnionParam {
	if support.Default == nil {
		return nil
	}
	tool := openai.ChatCompletionFunctionTool(openai.FunctionDefinitionParam{Name: "request_human_handoff", Description: openai.String("用户明确要求人工接待，或确认上一轮人工接待提议时调用。否定、引用、询问能力不代表接待请求。系统会暂停当前会话 AI 并通知接待人。"), Parameters: openai.FunctionParameters{"type": "object", "properties": map[string]any{}, "additionalProperties": false}})
	return &tool
}
func (t *HumanHandoffTool) BuildSystemPrompt(context.Context, *robotctx.RobotContext) (string, error) {
	return "用户明确请求人工接待时调用 request_human_handoff，不要仅口头承诺已经转接。", nil
}
func (t *HumanHandoffTool) ExecuteToolCall(ctx context.Context, rc *robotctx.RobotContext, call openai.ChatCompletionMessageToolCallUnion) (string, bool, error) {
	var args map[string]any
	if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil || len(args) != 0 {
		return "", false, errors.New("人工接待工具不接受参数")
	}
	peer, room := rc.FromWxID, ""
	at := []string{}
	if strings.HasSuffix(peer, "@chatroom") {
		room = peer
		peer = rc.SenderWxID
		at = append(at, peer)
	}
	changed, err := support.Default.TakeoverForTurn(peer, room, "客户请求人工接待", rc.ReceptionVersion)
	if err != nil {
		return "", false, err
	}
	if !changed {
		return vars.AIEnded, true, nil
	}
	target := peer
	if room != "" {
		target = room
	}
	if err := support.Default.SendText(target, "已进入人工接待，AI 暂停回复，请稍候。", at...); err != nil {
		return "", false, err
	}
	return vars.AIEnded, true, nil
}
