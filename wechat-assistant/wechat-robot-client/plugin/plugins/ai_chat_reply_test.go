package plugins

import (
	"reflect"
	"testing"

	"wechat-robot-client/interface/plugin"
	"wechat-robot-client/model"
)

type replyRecorder struct {
	plugin.MessageServiceIface
	peer, text string
	at         []string
	calls      int
}

func (r *replyRecorder) SendTextMessage(peer, text string, at ...string) error {
	r.peer, r.text, r.at = peer, text, at
	r.calls++
	return nil
}

func TestAIReplySentAsWechatText(t *testing.T) {
	for _, group := range []bool{false, true} {
		name, peer := "private", "customer"
		var mentions []string
		if group {
			name, peer, mentions = "group", "room@chatroom", []string{"customer"}
		}
		t.Run(name, func(t *testing.T) {
			recorder := &replyRecorder{}
			ctx := &plugin.MessageContext{Message: &model.Message{FromWxID: peer, SenderWxID: "customer", IsChatRoom: group}, MessageService: recorder}
			(&AIChatPlugin{}).SendMessage(ctx, "### **入驻流程**\n1. **提交材料**\n2. **评审通过后签约**\n咨询：138****5678")
			if recorder.calls != 1 || recorder.peer != peer || !reflect.DeepEqual(recorder.at, mentions) || recorder.text != "入驻流程\n1. 提交材料\n2. 评审通过后签约\n咨询：138****5678" {
				t.Fatalf("unexpected outgoing reply: %+v", recorder)
			}
			(&AIChatPlugin{}).SendMessage(ctx, "***")
			if recorder.calls != 1 {
				t.Fatal("formatting-only reply must not send an empty message")
			}
		})
	}
}
