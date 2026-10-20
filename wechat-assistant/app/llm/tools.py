"""Native Chat Completions tools exposed to the customer service model."""

CONVERSATION_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": (
                "检索已上传并启用的 PDF、Word 等知识文档，返回相关原文、文档名称与出处。每次查询一个问题，多问题可调用多次。"
                "回答课程、公司、价格、时间、政策、讲师等事实之前必须查询；"
                "事实不足时不能用模型记忆补全。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "结合历史补全的独立问题，保留用户的产品名、否定、数字等限定，不得增加条件。",
                    },
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "request_human_handoff",
            "description": (
                "用户明确请求人工接待，或确认历史中的转人工提议时调用。"
                "否定转接、引用他人的话、仅询问能力、投诉或提到讲师都不代表转接请求。"
                "调用后由渠道执行转接；不要自行承诺已经转接成功。"
            ),
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
]
