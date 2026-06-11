# 配置说明

项目默认读取 `config.json`，缺失字段会使用默认值。敏感信息建议只放环境变量。

如果你想把配置放到其他位置，可以设置：

```bash
CONFIG_PATH=./my-config.json npm start
```

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
