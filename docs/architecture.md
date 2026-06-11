# 架构

```text
frontend/                 React + Ant Design 前端
src/server/index.ts       Express API 入口
src/server/config.ts      配置加载和环境变量合并
src/server/store.ts       内存状态 + 本地 Markdown 保存
src/server/providers/     外部服务适配器
```

Provider 边界：

- `bilibili.ts`：视频信息、公开字幕、可选 B站 AI 字幕。
- `ai.ts`：字幕校正、学习笔记总结、短标题。
- `asr.ts`：无字幕时的云端 ASR。
- `feishu.ts`：Markdown 转飞书 Docx 块并同步。

后端 API 尽量保持无状态。运行时任务状态存在内存中，最终产物写入 `notes/`。
