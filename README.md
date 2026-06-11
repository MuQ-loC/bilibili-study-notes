# B站视频总结工具

面向学习教程的 B站视频总结工作台：解析 B站链接、获取公开字幕、调用 AI 校正和总结、生成短标题、保存 Markdown，并可同步到飞书云文档。

这是 BYOK（Bring Your Own Key）工具：仓库不内置 API Key，所有云服务都通过环境变量或 `config.json` 配置。

## 功能

- 解析 B站视频链接、短链和 BV 号。
- 优先读取 B站公开字幕。
- 可选 ASR 兜底转写无字幕视频。
- AI 字幕校正、学习笔记总结、10 字以内短标题。
- 单视频工作台：播放、字幕、总结、截图、飞书同步。
- 合集/专辑批量总结：并发处理、自动加序号标题。
- 本地 Markdown 输出。
- 飞书 Docx 结构化写入，不把 Markdown 符号原样贴进去。

## 快速开始

要求：

- Node.js 20+
- npm
- 可选：`yt-dlp`，仅在需要 ASR 提取音频时使用

安装依赖：

```bash
npm install
npm --prefix frontend install
```

创建配置：

```bash
cp config.example.json config.json
```

启动：

```bash
npm run dev:api
npm run dev:web
```

访问：

```text
http://127.0.0.1:8792
```

生产构建：

```bash
npm run build
npm start
```

## 配置

常用环境变量：

```text
BILIBILI_COOKIE
DEEPSEEK_API_KEY
OPENAI_API_KEY
DIFY_API_KEY
FEISHU_ENABLED
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_FOLDER_TOKEN
FEISHU_DOCUMENT_ID
```

更多说明见：

- `docs/configuration.md`
- `docs/architecture.md`
- `docs/contributing.md`

## 开源边界

这个工具用于个人学习笔记整理。不要公开分发原视频、完整字幕、大量截图或他人课程内容。公开笔记时保留来源链接，避免替代原视频。

## License

MIT
