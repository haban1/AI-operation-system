package utils

import "testing"

func TestFormatWechatAIReply(t *testing.T) {
	tests := []struct{ name, input, want string }{
		{"knowledge reply", "### **入驻流程**\n\n1. **准备材料**：发送到官方邮箱。\n2. **初审**：3-5 个工作日。\n3. ***签约入驻***：15 日内完成。", "入驻流程\n\n1. 准备材料：发送到官方邮箱。\n2. 初审：3-5 个工作日。\n3. 签约入驻：15 日内完成。"},
		{"star list", "* **材料**：商业计划书\n  * 项目简介\n\n***\n请按时提交。", "· 材料：商业计划书\n  · 项目简介\n\n\n请按时提交。"},
		{"adjacent emphasis", "请先**提交材料**再**预约评审**。", "请先提交材料再预约评审。"},
		{"nested emphasis", "**请在 *15 日内* 签约**", "请在 15 日内 签约"},
		{"single character", "**好**，*是*，***对***，__确认__。", "好，是，对，确认。"},
		{"masked data", "手机号 138****5678，证件号 44**************12，密码：****", "手机号 138****5678，证件号 44**************12，密码：****"},
		{"arithmetic", "2 * 3 * 4 = 24；2**3 = 8；a*b*c；x**y**z", "2 * 3 * 4 = 24；2**3 = 8；a*b*c；x**y**z"},
		{"business values", "**费用**：1,200.50 元；2026-10-20；service@example.com；[1]", "费用：1,200.50 元；2026-10-20；service@example.com；[1]"},
		{"url", "**官网**：https://example.com/a*b*c?q=**x**&id=a_b_c", "官网：https://example.com/a*b*c?q=**x**&id=a_b_c"},
		{"emphasized url", "官网：**https://example.com/a*b*c**", "官网：https://example.com/a*b*c"},
		{"inline code", "请执行 `a**b**c`，再查看 **结果**。", "请执行 a**b**c，再查看 结果。"},
		{"fenced code", "示例：\n```python\nvalue = a**b**c\n# comment\n```\n**结束**", "示例：\nvalue = a**b**c\n# comment\n结束"},
		{"plain text", "您好！\n请准备材料，资料齐全后申报。\n电话：020-12345678", "您好！\n请准备材料，资料齐全后申报。\n电话：020-12345678"},
		{"empty", " \r\n ", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := FormatWechatAIReply(tt.input); got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}
