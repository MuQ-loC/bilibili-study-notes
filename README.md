# B站视频总结工具

面向学习教程的 B站视频总结工作台：解析 B站链接、获取公开字幕、调用 AI 校正和总结、生成短标题、保存 Markdown，并可同步到飞书云文档。

这是 BYOK（Bring Your Own Key）工具：仓库不内置 API Key。默认配置已经内置，通常只需要设置环境变量，比如 `DEEPSEEK_API_KEY`；只有要换模型、换接口地址、启用飞书或 ASR 时，才需要创建 `config.json`。

## 功能

- 解析 B站视频链接、短链和 BV 号。
- 优先读取 B站公开字幕。
- 本地 faster-whisper / OpenAI ASR 兜底转写无字幕视频。
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

最小配置只需要一个 Key。以 DeepSeek 为例：

```bash
export DEEPSEEK_API_KEY="sk-..."
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY="sk-..."
```

`config.json` 不是必需的。只有要覆盖默认配置时才复制示例：

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

默认情况下，不创建 `config.json` 也能启动。项目会使用这些默认值：

- AI：DeepSeek OpenAI-compatible
- 模型：`deepseek-chat`
- ASR：默认关闭
- 飞书：默认关闭

常用环境变量：

```text
BILIBILI_COOKIE
DEEPSEEK_API_KEY
OPENAI_API_KEY
ASR_PROVIDER
ASR_MODEL
OPENAI_BASE_URL
LOCAL_ASR_PYTHON
LOCAL_ASR_MODEL
LOCAL_ASR_DEVICE
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
