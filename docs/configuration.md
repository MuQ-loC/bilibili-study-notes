# 配置说明

`config.json` 是可选的，不是必填项。

项目缺失 `config.json` 时会使用默认配置。大多数用户只需要设置环境变量，比如 `DEEPSEEK_API_KEY`，就可以直接启动。

默认配置：

- AI Provider：DeepSeek OpenAI-compatible
- Base URL：`https://api.deepseek.com`
- Model：`deepseek-chat`
- ASR：关闭
- 飞书：关闭

敏感信息建议只放环境变量，不要写进仓库。

如果你想换模型、换接口地址、启用飞书或 ASR，再复制配置文件：

```bash
cp config.example.json config.json
```

如果你想把配置放到其他位置，可以设置：

```bash
CONFIG_PATH=./my-config.json npm start
```

常用环境变量：

```text
BILIBILI_COOKIE
DEEPSEEK_API_KEY
OPENAI_API_KEY
ASR_PROVIDER
ASR_MODEL
OPENAI_BASE_URL
DIFY_API_KEY
FEISHU_ENABLED
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_FOLDER_TOKEN
FEISHU_DOCUMENT_ID
```

`config.example.json` 是开源示例，不包含密钥。

## AI Provider

`ai.provider` 可选：

- `openai_compatible`
- `deepseek`
- `ollama`
- `dify`

`deepseek` 目前按 OpenAI-compatible 接口处理。

## ASR Provider

`asr.provider` 可选：

- `none`
- `openai`

`openai` ASR 需要额外安装 `yt-dlp`，后端会先提取音频再上传转写。

不想创建 `config.json` 时，可以直接用环境变量启用 ASR：

```powershell
$env:ASR_PROVIDER="openai"
$env:OPENAI_API_KEY="sk-..."
```

长视频会被提取为 16k 单声道低码率 mp3，降低 OpenAI Whisper 文件大小超限的概率。
