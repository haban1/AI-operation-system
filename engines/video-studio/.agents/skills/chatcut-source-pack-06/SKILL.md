---
name: chatcut-source-pack-06
description: 按已选上游 Skill 组合制作对照蒙太奇｜台上与台下，支持视频和照片；保留选片依据与可选文字模块。
---

这是用户项目的组合入口，不是上游作者发布的官方套装，也不是新的剪辑风格原文。

先完整读取下列原文，再做选片和结构设计：
- [editing-montage](references/editing-montage.md)
- [multi-clips-to-reels](references/multi-clips-to-reels-package.txt)

原文规则优先。区分原文必须项、原文提供的选项、针对素材作出的判断。当前选用规则：原文 contrast / parallel / motif return；镜头语义关系推动剪辑；不伪造跨场次时空连续。不要将示例时长或本次镜头表当成所有项目的固定模板。

执行时重新审看素材，独立建立镜头角色、源时间码、事实依据和节奏表。载入 ChatCut basics、verification；导出时再载入 export。保持原生可编辑时间线。先检查一个代表片段，再扩展。

读取 config.json。自然语言“不要说明文字”“不用配乐”“不要画中画”分别覆盖 descriptive_text、music、picture_in_picture。禁止启用的 Skill 优先从 enabled_skills 去除；若移除主导结构 Skill，说明组合已改变并重新选适用原文，不得继续声称完全遵循原套装。用户要求关闭与原文核心规则冲突时，记录偏离。

默认沿用实拍主体铺满画面、少量说明文字、纯音乐、无新增配音的制作偏好；不同活动不得暗示为同一场。用户本次明确要求优先于默认值。输出到本次系统任务目录，完成校验后登记成片路径；除非用户明确要求，不移动或删除源素材及下载原件。
