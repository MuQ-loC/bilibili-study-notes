import crypto from 'node:crypto';
import type { AppConfig, Summary, Video } from '../types.js';

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
type SparkResponse = {
  header?: { code?: number; message?: string; status?: number };
  payload?: { choices?: { status?: number; text?: Array<{ content?: string }> } };
};

export class AIProvider {
  constructor(private cfg: AppConfig['ai']) {}

  async summarize(video: Video, transcript: string, instruction: string): Promise<Summary> {
    const content = await this.complete(buildSummaryMessages(video, transcript, instruction));
    return { id: '', video_id: video.id, model: this.modelName(), markdown: applyGlossary(content) };
  }

  async correctTranscript(video: Video, transcript: string): Promise<string> {
    return this.complete(buildCorrectionMessages(video, transcript));
  }

  async shortTitle(video: Video, text: string, index = 0): Promise<{ short_title: string; title: string }> {
    let raw = '';
    try {
      raw = await this.complete(buildTitleMessages(video, text));
    } catch {
      raw = '';
    }
    const short = cleanShortTitle(raw, video.title);
    return { short_title: short, title: index > 0 ? `${String(index).padStart(2, '0')}-${short}` : short };
  }

  private async complete(messages: ChatMessage[]): Promise<string> {
    if (this.cfg.provider === 'dify') return this.completeDify(messages.at(-1)?.content || '');
    if (this.cfg.provider === 'spark') return this.completeSpark(messages);
    return this.completeOpenAICompatible(messages);
  }

  private async completeOpenAICompatible(messages: ChatMessage[]): Promise<string> {
    const provider = this.cfg.provider;
    const baseUrl = this.cfg.base_url || (provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.deepseek.com');
    const model = this.cfg.model || (provider === 'ollama' ? 'qwen2.5:7b-instruct' : 'deepseek-chat');
    if (provider !== 'ollama' && !this.cfg.api_key) throw new Error('未配置 AI API Key');

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.cfg.api_key ? { Authorization: `Bearer ${this.cfg.api_key}` } : {})
      },
      body: JSON.stringify({ model, messages, temperature: 0.15 })
    });
    if (!res.ok) throw new Error(`AI API HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (data.error?.message) throw new Error(data.error.message);
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('AI API 没有返回内容');
    return content;
  }

  private async completeDify(prompt: string): Promise<string> {
    if (!this.cfg.api_key) throw new Error('未配置 Dify API Key');
    const appType = this.cfg.dify_app_type || 'chat';
    const endpoint = appType === 'completion' ? '/completion-messages' : '/chat-messages';
    const res = await fetch(`${this.cfg.base_url.replace(/\/$/, '')}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.api_key}` },
      body: JSON.stringify({
        inputs: { query: prompt, prompt, text: prompt },
        query: appType === 'completion' ? undefined : prompt,
        response_mode: 'blocking',
        user: this.cfg.dify_user || 'bilibili-study-notes'
      })
    });
    if (!res.ok) throw new Error(`Dify API HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { answer?: string; message?: string };
    if (data.message) throw new Error(data.message);
    if (!data.answer?.trim()) throw new Error('Dify 没有返回内容');
    return data.answer;
  }

  private completeSpark(messages: ChatMessage[]): Promise<string> {
    const appId = this.cfg.spark_app_id || '';
    const apiKey = this.cfg.spark_api_key || '';
    const apiSecret = this.cfg.spark_api_secret || '';
    if (!appId || !apiKey || !apiSecret) throw new Error('Spark APPID/APIKey/APISecret is not configured');
    const model = this.cfg.model || 'generalv3.5';
    const url = this.signedSparkUrl(this.sparkEndpoint(model), apiKey, apiSecret);
    const domain = this.sparkDomain(model);
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) throw new Error('WebSocket is not available in this Node.js runtime');

    return new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(url);
      let content = '';
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('Spark API timeout'));
        }
      }, 120000);

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          header: { app_id: appId, uid: 'bilibili-study-notes' },
          parameter: {
            chat: {
              domain,
              temperature: 0.15,
              max_tokens: 8192
            }
          },
          payload: {
            message: {
              text: normalizeSparkMessages(messages)
            }
          }
        }));
      });

      socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(String(event.data)) as SparkResponse;
          const code = data.header?.code ?? 0;
          if (code !== 0) {
            throw new Error(`Spark API ${code}: ${data.header?.message || 'request failed'}`);
          }
          for (const item of data.payload?.choices?.text || []) content += item.content || '';
          if (data.header?.status === 2 || data.payload?.choices?.status === 2) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              socket.close();
              const out = content.trim();
              out ? resolve(out) : reject(new Error('Spark API returned empty content'));
            }
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            socket.close();
            reject(err);
          }
        }
      });

      socket.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Spark WebSocket connection failed'));
        }
      });

      socket.addEventListener('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          content.trim() ? resolve(content.trim()) : reject(new Error('Spark WebSocket closed before returning content'));
        }
      });
    });
  }

  private signedSparkUrl(endpoint: string, apiKey: string, apiSecret: string): string {
    const parsed = new URL(endpoint);
    const host = parsed.host;
    const path = parsed.pathname;
    const date = new Date().toUTCString();
    const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
    const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
    const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    parsed.searchParams.set('authorization', Buffer.from(authorizationOrigin).toString('base64'));
    parsed.searchParams.set('date', date);
    parsed.searchParams.set('host', host);
    return parsed.toString();
  }

  private sparkEndpoint(model: string): string {
    if (this.cfg.base_url?.startsWith('ws')) return this.cfg.base_url;
    const normalized = model.toLowerCase();
    if (normalized.includes('4.0') || normalized.includes('ultra')) return 'wss://spark-api.xf-yun.com/v4.0/chat';
    if (normalized.includes('3.5') || normalized.includes('max')) return 'wss://spark-api.xf-yun.com/v3.5/chat';
    if (normalized.includes('3.1') || normalized.includes('pro')) return 'wss://spark-api.xf-yun.com/v3.1/chat';
    return 'wss://spark-api.xf-yun.com/v1.1/chat';
  }

  private sparkDomain(model: string): string {
    const normalized = model.toLowerCase();
    if (normalized.includes('4.0') || normalized.includes('ultra')) return '4.0Ultra';
    if (normalized.includes('3.5') || normalized.includes('max')) return 'generalv3.5';
    if (normalized.includes('3.1') || normalized.includes('pro')) return 'generalv3';
    return 'general';
  }

  private modelName(): string {
    return this.cfg.provider === 'dify' ? `dify/${this.cfg.dify_app_type || 'chat'}` : this.cfg.model;
  }
}

function normalizeSparkMessages(messages: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  let system = '';
  for (const message of messages) {
    if (message.role === 'system') {
      system += (system ? '\n' : '') + message.content;
      continue;
    }
    if (system) {
      normalized.push({ role: 'user', content: `系统要求：\n${system}\n\n用户任务：\n${message.content}` });
      system = '';
    } else {
      normalized.push(message);
    }
  }
  if (system) normalized.push({ role: 'user', content: system });
  return normalized;
}

function buildSummaryMessages(video: Video, transcript: string, instruction: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你是偏工程化的学习教程笔记助手。',
        '输出能复习、能照做、能查漏补缺的 Markdown 中文学习笔记。',
        '无论字幕是中文、英文还是中英混合，最终笔记都必须用中文表达。',
        '英文术语、论文名、API、命令、代码和参数名保留原文，并在首次出现时用中文解释。',
        '列表编号必须显式递增，禁止连续写多个 1. 让 Markdown 自动编号。'
      ].join('\n')
    },
    { role: 'user', content: buildSummaryPrompt(video, transcript, instruction) }
  ];
}

function buildCorrectionMessages(video: Video, transcript: string): ChatMessage[] {
  return [
    { role: 'system', content: '你是技术教程字幕校对助手，只修正 ASR 错词和技术术语，不总结、不删减。英文课程可以保留英文原句，但明显识别错误要修正。' },
    { role: 'user', content: buildCorrectionPrompt(video, transcript) }
  ];
}

function buildTitleMessages(video: Video, text: string): ChatMessage[] {
  return [
    { role: 'system', content: '你是学习笔记标题编辑，只输出中文短标题。' },
    { role: 'user', content: buildTitlePrompt(video, text) }
  ];
}

function buildSummaryPrompt(video: Video, transcript: string, instruction: string): string {
  const clipped = Array.from(transcript).slice(0, 60000).join('');
  return `# 视频信息

标题：${video.title}
UP主：${video.owner}
BVID：${video.bvid}

# 额外要求

${instruction || '按学习教程笔记格式整理，重点提取操作步骤、关键概念、命令、易错点和复习清单。'}

# 语言规则

- 最终笔记必须使用中文输出。
- 如果字幕或转写是英文、中英混合、英文课程，请先理解英文含义，再总结成中文学习笔记。
- 关键英文术语、论文名、代码、命令、参数名、API 名称保留英文原文，并在首次出现时用中文解释。
- 不要大段复制英文字幕，不要输出英文段落式总结。

# 输出格式

请用 Markdown 输出，必须包含：

1. 课程目标
2. 前置知识
3. 时间轴目录
4. 分段学习笔记
5. 操作步骤
6. 命令/代码/配置项
7. 关键概念解释
8. 易错点和坑
9. 复习清单
10. 可执行 TODO

要求：
- 不要写空泛套话。
- 不要只复述字幕。
- 每个知识点尽量带时间戳。
- 表格只用于非常适合对齐的信息；不要为了所有内容强行做表格。
- 如果使用有序列表，必须写成 1、2、3 显式递增；不要连续写多个 1.。
- 操作步骤优先写成“步骤 1：xxx”“步骤 2：xxx”，步骤下面再用无序列表列细节。
- 如果字幕中有命令、路径、参数、代码，要用代码块列出来。
- 英文课程要转写为中文讲解，不要把原英文字幕直接粘贴成笔记主体。
- 术语必须统一：只写 ComfyUI，不要写 ComboUI、ComfoUI、comboui、康薄优艾、咖啡员哀。

# 字幕/转写

${clipped}`;
}

function buildCorrectionPrompt(video: Video, transcript: string): string {
  const clipped = Array.from(transcript).slice(0, 60000).join('');
  return `# 任务

校正下面这份技术教程 ASR 转写稿。

必须：
- 保留每行开头时间戳。
- 不要总结，不要改写成文章，不要删减信息。
- 只修正明显语音识别错误、错别字、同音词、技术术语。
- 中文课程输出中文校正文稿；英文课程保留英文内容，不要在校正阶段翻译。
- 输出纯文本。

# 视频信息

标题：${video.title}
UP主：${video.owner}

# 原始 ASR

${clipped}`;
}

function buildTitlePrompt(video: Video, text: string): string {
  const clipped = Array.from(text).slice(0, 3000).join('');
  return `给这份 B站学习教程笔记起一个中文短标题。

严格要求：
- 不超过 10 个中文/英文字符。
- 不要序号、标点、引号、括号、Markdown。
- 只输出标题本身。
- 不要写“学习笔记”“视频总结”。
- 即使原视频是英文，也要输出中文标题。

视频标题：${video.title}

笔记内容：
${clipped}`;
}

export function applyGlossary(value: string): string {
  return value
    .replaceAll('咖啡员哀', 'ComfyUI')
    .replaceAll('康薄优艾', 'ComfyUI')
    .replaceAll('ComboUI', 'ComfyUI')
    .replaceAll('ComfoUI', 'ComfyUI')
    .replaceAll('comboui', 'ComfyUI')
    .replaceAll('魔仙', '模型')
    .replaceAll('模仙', '模型')
    .replaceAll('彩阳器', '采样器')
    .replaceAll('暴错', '报错');
}

function cleanShortTitle(value: string, fallback: string): string {
  const first = applyGlossary(value).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  let title = first.replace(/^#+/, '').replace(/^(短标题|标题)[:：]/, '').replace(/[`"'“”‘’【】\[\]（）()《》:：,，.。!！?？|/\\\s]/g, '');
  if (!title) title = fallbackShortTitle(fallback);
  if (Array.from(title).length > 10 && title.includes('ComfyUI')) {
    if (title.includes('工作流')) return 'ComfyUI工作流';
    return 'ComfyUI教程';
  }
  return Array.from(title || '学习笔记').slice(0, 10).join('');
}

function fallbackShortTitle(title: string): string {
  const cleaned = applyGlossary(title).replace(/[`"'“”‘’【】\[\]（）()《》:：,，.。!！?？|/\\\s]/g, '');
  if (cleaned.includes('ComfyUI')) return 'ComfyUI教程';
  return Array.from(cleaned || '学习笔记').slice(0, 10).join('');
}
