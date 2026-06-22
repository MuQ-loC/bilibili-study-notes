# B站视频总结工具

> 把 B 站长教程、合集、公开课，变成可以复习、检索、同步到飞书的结构化学习笔记。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![BYOK](https://img.shields.io/badge/BYOK-Bring%20Your%20Own%20Key-blue)](#-配置方式)
[![Local First](https://img.shields.io/badge/Local--First-ASR%20%2B%20Markdown-orange)](#-核心功能)

很多学习视频不是“看完”就结束了。真正麻烦的是：字幕乱、专有名词错、合集太长、笔记不好复习、飞书里格式又容易碎。

这个工具就是为这个场景做的：输入一个 B 站视频或合集链接，自动完成字幕获取 / 本地转写 / AI 校正 / 学习笔记总结 / 飞书同步。

## ✨ 核心功能

- 🎬 **单视频工作台**：解析视频、获取字幕、转写、校正、总结、保存、同步飞书。
- 📚 **合集 / 分 P 课程管理**：自动展开章节，支持并发处理整套课程。
- 🎙️ **本地 ASR 优先**：支持 faster-whisper、FunASR、SenseVoice，可跑 CUDA。
- ☁️ **云端 ASR 可选**：支持 OpenAI-compatible ASR、讯飞星火 IAT。
- 🧠 **AI 分工配置**：总结、字幕校正、短标题可以分别设置模型和服务商。
- 📝 **学习笔记模板**：输出课程目标、时间轴、操作步骤、关键概念、易错点、复习清单。
- 🔁 **断点续跑**：课程、课时、音频缓存、转写、总结都会保存，后面可以继续处理。
- 📤 **飞书同步**：支持保存到飞书文档或飞书文件夹。
- 🔐 **BYOK**：不内置任何 API Key，适合开源、自部署和二次开发。

## 🖼️ 适合谁

- 想把 B 站公开课整理成长期可复习笔记的人。
- 想批量处理 AI、编程、设计、科研教程合集的人。
- 想用本地 GPU 跑 ASR，减少云端转写费用的人。
- 想把视频学习沉淀到飞书知识库的人。
- 想二次开发一个“视频课程知识库”工具的人。

## 🚀 快速开始

### 1. 环境要求

- Node.js 20+
- npm
- 可选：Python ASR 环境，只有本地转写时需要
- 可选：`yt-dlp` / `ffmpeg`，用于下载和处理音频

### 2. 安装依赖

```bash
npm install
npm --prefix frontend install
```

### 3. 配置模型 Key

项目是 BYOK 模式。最小配置只需要一个 OpenAI-compatible Key，例如：

```bash
export NEWAPI_API_KEY="sk-..."
```

Windows PowerShell：

```powershell
$env:NEWAPI_API_KEY="sk-..."
```

如果你用 DeepSeek，也可以配置：

```bash
export DEEPSEEK_API_KEY="sk-..."
```

### 4. 启动开发服务

```bash
npm run dev:api
npm run dev:web
```

打开：

```text
http://127.0.0.1:8792
```

## 🧭 使用流程

### 单视频

1. 粘贴 B 站视频链接。
2. 点击解析，优先读取 B 站公开字幕。
3. 没有字幕时，点击“只转写”或“一键跑本视频”。
4. 校正文稿，生成学习笔记。
5. 保存本地 Markdown，或同步到飞书。

### 合集 / 分 P 课程

1. 粘贴合集、专辑或分 P 视频链接。
2. 设置并发数和数量限制。
3. 一键批量总结。
4. 在“课程管理”里继续处理单个课时。
5. 点击“刷新课程”可同时重新解析章节并恢复本地 ASR 缓存。

## ⚙️ 配置方式

默认不需要创建 `config.json`。需要覆盖默认配置时再复制：

```bash
cp config.example.json config.json
```

常用环境变量：

```text
BILIBILI_COOKIE
NEWAPI_API_KEY
DEEPSEEK_API_KEY
OPENAI_API_KEY
SPARK_APP_ID
SPARK_API_KEY
SPARK_API_SECRET
LOCAL_ASR_PYTHON
LOCAL_ASR_DEVICE
FEISHU_ENABLED
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_FOLDER_TOKEN
FEISHU_DOCUMENT_ID
```

更多说明：

- [配置说明](docs/configuration.md)
- [架构说明](docs/architecture.md)
- [贡献指南](docs/contributing.md)

## 🧩 支持的模型和服务

| 能力 | 支持 |
|---|---|
| 总结模型 | OpenAI-compatible、DeepSeek、Ollama、Dify、讯飞星火 |
| 字幕校正 | 可独立配置模型 |
| 短标题 | 可独立配置模型，适合飞书文档命名 |
| 本地 ASR | faster-whisper、FunASR、SenseVoice |
| 云端 ASR | OpenAI-compatible ASR、讯飞星火 IAT |
| 笔记输出 | 本地 Markdown、飞书文档 |

## 📁 项目结构

```text
bilibili-study-notes/
├─ frontend/              # Ant Design 前端工作台
├─ src/server/            # Express API 与业务流程
├─ src/server/providers/  # B站、AI、ASR、飞书、TTS provider
├─ tools/                 # 本地 ASR / 下载辅助脚本
├─ docs/                  # 配置、架构、贡献文档
├─ notes/                 # 本地生成内容，默认不提交
└─ config.example.json    # 示例配置
```

## 🛡️ 开源边界

这个工具用于个人学习笔记整理。请不要公开分发原视频、完整字幕、大量截图或他人课程内容。

建议公开分享时：

- 保留原视频链接和作者信息。
- 只发布自己的学习笔记和理解。
- 不要让笔记替代原课程。

## 🌟 Star 一下？

如果这个项目帮你把长视频课程变成了真正能复习的笔记，欢迎点个 Star。

后续会继续优化：

- 更好的课程知识库检索
- 更稳定的本地 ASR 安装体验
- 更漂亮的飞书排版
- 更多笔记模板
- Docker 一键部署

## License

MIT
