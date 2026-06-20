import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import type { AppConfig, Transcript, Video } from '../types.js';

export class ASRProvider {
  constructor(private cfg: AppConfig['asr']) {}

  async transcribe(video: Video, onProgress?: (message: string) => void): Promise<Transcript> {
    if (this.cfg.provider === 'none') {
      throw new Error('ASR 未启用。请配置 ASR_PROVIDER=local/openai，或使用 B站公开字幕。');
    }
    if (this.cfg.provider === 'local') return this.transcribeLocal(video, onProgress);
    if (this.cfg.provider === 'spark') {
      await fs.mkdir(this.cfg.work_dir, { recursive: true });
      onProgress?.('Downloading audio with yt-dlp...');
      const audioPath = await downloadAudio(video.url, this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
      onProgress?.('Uploading audio to Xunfei ASR...');
      const text = await transcribeSpark(audioPath, this.cfg, onProgress);
      return { source: `spark_asr/${this.cfg.model || 'lfasr'}`, language: 'zh-CN', content: text };
    }
    if (this.cfg.provider !== 'openai') {
      throw new Error(`暂不支持 ASR provider: ${this.cfg.provider}`);
    }
    if (!this.cfg.openai_api_key) throw new Error('未配置 OPENAI_API_KEY');
    await fs.mkdir(this.cfg.work_dir, { recursive: true });
    onProgress?.('正在用 yt-dlp 提取音频...');
    const audioPath = await downloadAudio(video.url, this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    onProgress?.('正在上传到 OpenAI Transcription API...');
    const text = await transcribeOpenAI(audioPath, this.cfg);
    return { source: `openai_asr/${this.cfg.model}`, language: 'zh-CN', content: text };
  }

  async transcribeAudio(video: Video, audioPath: string, onProgress?: (message: string) => void): Promise<Transcript> {
    if (this.cfg.provider === 'local') {
      return this.transcribeLocal(video, onProgress, audioPath);
    }
    if (this.cfg.provider === 'spark') {
      const content = await transcribeSpark(audioPath, this.cfg, onProgress);
      return { source: `spark_asr/${this.cfg.model || 'lfasr'}`, language: 'zh-CN', content };
    }
    if (this.cfg.provider === 'openai') {
      const content = await transcribeOpenAI(audioPath, this.cfg);
      return { source: `openai_asr/${this.cfg.model}`, language: 'zh-CN', content };
    }
    throw new Error('ASR is not enabled');
  }

  async downloadAudio(video: Video, onProgress?: (message: string) => void): Promise<string> {
    if (this.cfg.provider === 'none') {
      throw new Error('ASR is not enabled');
    }
    if (this.cfg.provider !== 'local') {
      await fs.mkdir(this.cfg.work_dir, { recursive: true });
      onProgress?.('Downloading audio with yt-dlp...');
      return downloadAudio(video.url, this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    }
    const pythonPath = this.cfg.python_path?.trim() || 'python';
    const scriptPath = path.join('tools', 'transcribe_bilibili.py');
    const workDir = path.join(this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    await fs.mkdir(workDir, { recursive: true });
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    return runJSONLines(pythonPath, [scriptPath, '--url', video.url, '--work-dir', workDir, '--download-only'], env, onProgress);
  }

  private async transcribeLocal(video: Video, onProgress?: (message: string) => void, audioPath?: string): Promise<Transcript> {
    const pythonPath = this.cfg.python_path?.trim() || 'python';
    const scriptPath = path.join('tools', 'transcribe_bilibili.py');
    const workDir = path.join(this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    await fs.mkdir(workDir, { recursive: true });
    const args = [
      scriptPath,
      '--url',
      video.url,
      '--work-dir',
      workDir,
      '--model',
      this.cfg.model || 'small',
      '--device',
      this.cfg.device || 'auto'
    ];
    if (audioPath) args.push('--audio', audioPath);
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const content = await runJSONLines(pythonPath, args, env, onProgress);
    return { source: `local_asr/${path.basename(this.cfg.model || 'small')}`, language: 'zh-CN', content };
  }
}

async function downloadAudio(url: string, workDir: string, id: string): Promise<string> {
  const safeID = id.replace(/[^0-9A-Za-z_-]/g, '_');
  const out = path.join(workDir, `${safeID}.%(ext)s`);
  await run('yt-dlp', [
    '-x',
    '--audio-format',
    'mp3',
    '--postprocessor-args',
    'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
    '-o',
    out,
    url
  ]);
  return path.join(workDir, `${safeID}.mp3`);
}

async function transcribeOpenAI(filePath: string, cfg: AppConfig['asr']): Promise<string> {
  const data = await fs.readFile(filePath);
  const form = new FormData();
  form.append('model', cfg.model || 'whisper-1');
  form.append('file', new Blob([data]), path.basename(filePath));
  form.append('response_format', 'json');
  const res = await fetch(`${cfg.openai_base_url.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.openai_api_key}` },
    body: form
  });
  if (!res.ok) throw new Error(`OpenAI ASR HTTP ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { text?: string };
  if (!out.text?.trim()) throw new Error('OpenAI ASR 没有返回文本');
  return out.text.trim();
}

async function transcribeSpark(filePath: string, cfg: AppConfig['asr'], onProgress?: (message: string) => void): Promise<string> {
  const appId = cfg.spark_app_id || '';
  const secretKey = cfg.spark_api_secret || '';
  if (!appId || !secretKey) throw new Error('Spark ASR APPID/APISecret is not configured');
  const stat = await fs.stat(filePath);
  const base = 'https://raasr.xfyun.cn/v2/api';
  const common = sparkAsrAuth(appId, secretKey);
  const uploadParams = new URLSearchParams({
    ...common,
    fileName: path.basename(filePath),
    fileSize: String(stat.size),
    duration: '200',
    language: 'cn',
    roleType: '0',
    languageType: '1',
    pd: 'edu'
  });
  onProgress?.('Uploading audio to Xunfei long-form ASR...');
  const uploadRes = await fetch(`${base}/upload?${uploadParams.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob([await fs.readFile(filePath)])
  });
  const uploadText = await uploadRes.text();
  if (!uploadRes.ok) throw new Error(`Spark ASR upload HTTP ${uploadRes.status}: ${uploadText}`);
  const upload = JSON.parse(uploadText) as { code?: string; descInfo?: string; content?: { orderId?: string }; data?: string };
  if (upload.code !== '000000') throw new Error(`Spark ASR upload failed ${upload.code}: ${upload.descInfo || uploadText}`);
  const orderId = upload.content?.orderId || upload.data || '';
  if (!orderId) throw new Error('Spark ASR upload did not return orderId');

  for (let attempt = 1; attempt <= 120; attempt += 1) {
    await sleep(5000);
    onProgress?.(`Polling Xunfei ASR result: ${attempt}`);
    const query = new URLSearchParams({ ...sparkAsrAuth(appId, secretKey), orderId, resultType: 'transfer,predict' });
    const res = await fetch(`${base}/getResult?${query.toString()}`, { method: 'POST' });
    const text = await res.text();
    if (!res.ok) throw new Error(`Spark ASR result HTTP ${res.status}: ${text}`);
    const data = JSON.parse(text) as { code?: string; descInfo?: string; content?: { orderInfo?: { status?: number | string }; orderResult?: string } };
    if (data.code !== '000000') throw new Error(`Spark ASR result failed ${data.code}: ${data.descInfo || text}`);
    const status = Number(data.content?.orderInfo?.status || 0);
    if (status === 4 || status === -1) throw new Error(`Spark ASR failed: ${text}`);
    if (status === 3 && data.content?.orderResult) {
      return parseSparkOrderResult(data.content.orderResult);
    }
  }
  throw new Error('Spark ASR timed out before returning text');
}

function sparkAsrAuth(appId: string, secretKey: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const md5 = crypto.createHash('md5').update(appId + ts).digest('hex');
  const signa = crypto.createHmac('sha1', secretKey).update(md5).digest('base64');
  return { appId, ts, signa };
}

function parseSparkOrderResult(raw: string): string {
  const data = JSON.parse(raw) as {
    lattice?: Array<{ json_1best?: { st?: { bg?: string; ed?: string; rt?: Array<{ ws?: Array<{ cw?: Array<{ w?: string }> }> }> } } }>;
  };
  const lines: string[] = [];
  for (const item of data.lattice || []) {
    const st = item.json_1best?.st;
    if (!st) continue;
    const words = (st.rt || [])
      .flatMap((rt) => rt.ws || [])
      .flatMap((ws) => ws.cw || [])
      .map((cw) => cw.w || '')
      .join('')
      .trim();
    if (!words) continue;
    const start = Number(st.bg || 0) / 1000;
    const end = Number(st.ed || st.bg || 0) / 1000;
    lines.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${words}`);
  }
  const content = lines.join('\n').trim();
  if (!content) throw new Error('Spark ASR returned empty transcript');
  return content;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function runJSONLines(command: string, args: string[], env: NodeJS.ProcessEnv, onProgress?: (message: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stderr = '';
    let stdout = '';
    let finalContent = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as { event?: string; message?: string; content?: string };
          if (event.event === 'done') finalContent = event.content || '';
          else if (event.event === 'error') {
            child.kill();
            reject(new Error(event.message || '本地 ASR 失败'));
          } else if (event.message) {
            onProgress?.(event.message);
          }
        } catch {
          onProgress?.(trimmed);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`本地 ASR exited with ${code}: ${stderr.trim()}`));
        return;
      }
      if (!finalContent.trim()) {
        reject(new Error(stderr.trim() || '本地 ASR 没有生成文本'));
        return;
      }
      resolve(finalContent.trim());
    });
  });
}
