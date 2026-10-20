# 01 微博平台闭环

## 范围与边界

本流程只实现微博适配器侧的安全采集、精确定位、发送和回执。回复文案继续由现有知识库与决策任务生成；适配器不自行生成回复，也不改变公共基类、Registry、Web、数据库或其他平台逻辑。

现场调试编号为 **01**。本次只依据仓库既有日志、HTML/JSON 证据和模拟测试开发，未启动真实浏览器，未执行真实发布、评论回复或私信回复。

## 真实页面证据

- 发布页编辑器：`textarea[placeholder="有什么新鲜事想分享给大家？"]`
- 发布素材控件：`input[type="file"][class*="_file_"]`，并兼容 accept 中的 video/image 控件
- 发布按钮：唯一可见且位于编辑器附近的精确文本按钮“发送”
- 内容声明入口：优先限定 `.woo-pop-ctrl`，声明选项只接受精确标签且必须唯一
- 评论页：`https://weibo.com/comment/inbox`，必须进入唯一“收到的评论”页签
- 评论行：`.wbpro-scroller-item`；稳定评论标识来自链接查询参数 `cid`
- 评论用户：`a[href^="/u/"]`；正文：`div[class*="_wbtext_"]`
- 评论回复入口：行内 `i.woo-font--comment`；实际编辑器位于全局模态框 `textarea[placeholder="发布你的回复"]`
- 评论模态框标题必须精确匹配 `回复 @目标用户`，发送按钮必须是模态框局部唯一“回复”按钮
- 私信页：`https://api.weibo.com/chat/#/chat`
- 会话行：`li.sessionlist`；会话标题：`.message .header .friendname`
- 消息气泡：`.message ul.chat-content > li`；只采集 `.message-item.other`
- 稳定私信标识：消息 `<li>` 的数字 `id/data-id/data-mid`
- 私信编辑器：`textarea#webchat-textarea.editor.textarea-content`，位于 `.textbox` 内，与消息列表 `.message` 同级的 `.text` 中；仅在已核验消息列表的直接父级 `.textbox` 内查找唯一可见输入框，发送方式为 Enter

## 发布闭环

1. 在打开页面前校验素材存在和发布文本非空。
2. 使用现有 `getPage()`/运行态守卫获取页面；准备阶段查找唯一编辑器、素材控件和内容声明。
3. 内容声明入口、目标声明选项必须唯一；不唯一或无法验证时不发送。
4. AUTO 模式最终点击前再次执行 `assertWeiboOperationAllowed()`，同时核对生命周期 generation。
5. 点击前记录当前 Feed 精确回显数和成功 Toast 数。
6. 只有“编辑器清空”且“新增精确 Feed 回显或新增精确成功 Toast”同时成立才返回成功。
7. 点击后的异常或证据不足统一返回 `NEEDS_CONFIRMATION`，禁止自动重试；点击前准备失败可返回 `FAILED`。
8. `verifyPublish()` 在管理页按唯一标题记录及任务时间窗复核，避免把历史内容当作本次发布。

## 评论闭环

1. 只从“收到的评论”页签采集。
2. 评论必须同时具备用户、正文和稳定数字 `commentId`；相同 `commentId` 去重。
3. 采集结果写入 `sourceVerified`、事件时间、历史标记和指纹。
4. 回复前拒绝历史消息、无稳定 ID、未验证来源、缺用户或缺原文的任务；阻断发生在 `getPage()` 之前。
5. 用用户名、原文和 `commentId` 精确定位唯一评论行。
6. 点击该行唯一回复入口后，只接受页面唯一回复编辑器，并校验模态框标题对应目标用户。
7. 最终发送前再次检查平台运行态；仅点击模态框局部唯一“回复”按钮。
8. 仅当编辑器清空且目标局部范围出现本次新增精确回复文本时确认成功，否则 `NEEDS_CONFIRMATION`。

## 私信闭环

1. 只遍历有未读标记的会话。
2. 打开会话后必须验证聊天标题与目标用户名一致。
3. 只采集真实 incoming 气泡 `.message-item.other`，并要求稳定数字 messageId。
4. 只有会话预览、无法提取原始气泡或缺稳定 ID 时，记录为 `previewOnly/sourceVerified=false` 并返回待确认；这种记录不得自动回复。
5. 回复前再次按会话、标题、原文、messageId、incoming 方向精确验证唯一来源。
6. 最终发送前再次检查平台运行态，通过私信编辑器 Enter 发送。
7. 仅当编辑器清空且 outgoing 范围出现本次新增精确回复文本时确认成功，否则 `NEEDS_CONFIRMATION`，不得盲目重试。

## 停止态与非幂等安全

- 页面获取仍经过公共 `assertRuntimeAllowed()`，关闭平台不得新建上下文/Profile。
- 微博采集循环和发布/回复最终动作前均调用 `assertWeiboOperationAllowed()`。
- lifecycle generation 变化会抛出 `PLATFORM_OPERATION_CANCELLED`，异常继续交给 Local Agent/Supervisor 处理，不被适配器吞成普通失败。
- 停止至少保证不再执行新的最终发送；已经点击但回执不明确的发布/回复必须 `NEEDS_CONFIRMATION`，不自动重试。

## 主任务现场验收（按编号 01 排队）

1. 在平台关闭状态准备排队任务，确认不打开微博 Profile/浏览器且不调用适配器。
2. 开启微博后，以测试账号执行一次草稿准备，再人工确认内容声明标签和唯一发送按钮。
3. 分别准备一条新评论和一条新私信，确认采集记录包含稳定 commentId/messageId。
4. 验证评论模态框标题与目标用户完全一致，私信聊天标题完全一致。
5. 现场发送后核对新增局部回显和 evidence JSON；人为制造回执超时，确认任务进入 `NEEDS_CONFIRMATION` 且不重试。

## 尚存现场风险

- 微博动态 CSS 类名和内容声明弹层可能随版本变化，必须用测试账号复核。
- 评论回复入口的动态祖先结构、模态框标题格式可能调整；任何不唯一均会安全停止。
- 私信当前证据显示 Enter 发送；若站点改为组合键或新增按钮，需要现场更新本文件内的发送策略。
- 页面回显延迟超过当前超时会产生保守的 `NEEDS_CONFIRMATION`，不会自动重试非幂等动作。
