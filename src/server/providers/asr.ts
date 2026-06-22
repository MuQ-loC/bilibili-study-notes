import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import type { AppConfig, Transcript, Video } from '../types.js';

type ASRRunOptions = {
  language?: AppConfig['asr']['language'];
};

type ASRLanguageCode = 'zh' | 'en' | 'auto';

export class ASRProvider {
  constructor(private cfg: AppConfig['asr']) {}

  async transcribe(video: Video, onProgress?: (message: string) => void, options: ASRRunOptions = {}): Promise<Transcript> {
    const runCfg = resolveASRConfig(this.cfg, options.language);
    const language = resolveASRLanguage(runCfg, options.language);
    if (runCfg.provider === 'none') {
      throw new Error('ASR is disabled. Enable local/openai/spark ASR, or use Bilibili public subtitles.');
    }
    if (runCfg.provider === 'local') return this.transcribeLocal(video, onProgress, undefined, runCfg, language);
    await fs.mkdir(runCfg.work_dir, { recursive: true });
    onProgress?.('Downloading audio with yt-dlp...');
    const audioPath = await downloadAudio(video.url, runCfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    if (runCfg.provider === 'spark') {
      onProgress?.('Uploading audio to Xunfei Spark IAT...');
      const content = await transcribeSpark(audioPath, runCfg, onProgress, language);
      return { source: `spark_asr/${runCfg.model || 'spark_iat'}/${language}`, language, content };
    }
    if (runCfg.provider === 'openai') {
      const content = await transcribeOpenAI(audioPath, runCfg, language);
      return { source: `openai_asr/${runCfg.model}/${language}`, language, content };
    }
    throw new Error(`Unsupported ASR provider: ${runCfg.provider}`);
  }

  async transcribeAudio(video: Video, audioPath: string, onProgress?: (message: string) => void, options: ASRRunOptions = {}): Promise<Transcript> {
    const runCfg = resolveASRConfig(this.cfg, options.language);
    const language = resolveASRLanguage(runCfg, options.language);
    if (runCfg.provider === 'local') return this.transcribeLocal(video, onProgress, audioPath, runCfg, language);
    if (runCfg.provider === 'spark') {
      const content = await transcribeSpark(audioPath, runCfg, onProgress, language);
      return { source: `spark_asr/${runCfg.model || 'spark_iat'}/${language}`, language, content };
    }
    if (runCfg.provider === 'openai') {
      const content = await transcribeOpenAI(audioPath, runCfg, language);
      return { source: `openai_asr/${runCfg.model}/${language}`, language, content };
    }
    throw new Error('ASR is not enabled');
  }

  async downloadAudio(video: Video, onProgress?: (message: string) => void): Promise<string> {
    if (this.cfg.provider === 'none') throw new Error('ASR is not enabled');
    if (this.cfg.provider !== 'local') {
      await fs.mkdir(this.cfg.work_dir, { recursive: true });
      onProgress?.('Downloading audio with yt-dlp...');
      return downloadAudio(video.url, this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    }
    const pythonPath = this.cfg.python_path?.trim() || 'python';
    const scriptPath = path.join('tools', 'transcribe_bilibili.py');
    const workDir = path.join(this.cfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    await fs.mkdir(workDir, { recursive: true });
    const env = withMediaToolPath({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    return runJSONLines(pythonPath, [scriptPath, '--url', video.url, '--work-dir', workDir, '--download-only'], env, onProgress);
  }

  private async transcribeLocal(
    video: Video,
    onProgress: ((message: string) => void) | undefined,
    audioPath: string | undefined,
    runCfg: AppConfig['asr'],
    language: ASRLanguageCode
  ): Promise<Transcript> {
    const pythonPath = runCfg.python_path?.trim() || 'python';
    const scriptPath = path.join('tools', 'transcribe_bilibili.py');
    const workDir = path.join(runCfg.work_dir, `${video.bvid}-${video.cid || video.id}`);
    await fs.mkdir(workDir, { recursive: true });
    const args = [
      scriptPath,
      '--url',
      video.url,
      '--work-dir',
      workDir,
      '--model',
      runCfg.model || 'small',
      '--device',
      runCfg.device || 'auto',
      '--engine',
      runCfg.local_engine || 'faster_whisper',
      '--language',
      language
    ];
    if (audioPath) args.push('--audio', audioPath);
    const env = withMediaToolPath({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    const content = await runJSONLines(pythonPath, args, env, onProgress);
    return {
      source: `local_asr/${runCfg.local_engine || 'faster_whisper'}/${path.basename(runCfg.model || 'small')}/${language}`,
      language,
      content
    };
  }
}

function resolveASRConfig(cfg: AppConfig['asr'], requested?: AppConfig['asr']['language']): AppConfig['asr'] {
  if (cfg.provider !== 'local') return cfg;
  const language = requested || cfg.language || 'foreign';
  const profile = language === 'zh' ? cfg.local_profiles?.zh : cfg.local_profiles?.foreign;
  if (!profile) return cfg;
  return {
    ...cfg,
    local_engine: profile.engine || cfg.local_engine,
    model: profile.model || cfg.model
  };
}

function resolveASRLanguage(cfg: AppConfig['asr'], requested?: AppConfig['asr']['language']): ASRLanguageCode {
  const language = requested || cfg.language || 'foreign';
  if (language === 'zh') return 'zh';
  if (language === 'auto') return 'auto';
  return 'en';
}

async function downloadAudio(url: string, workDir: string, id: string): Promise<string> {
  const safeID = id.replace(/[^0-9A-Za-z_-]/g, '_');
  const out = path.join(workDir, `${safeID}.%(ext)s`);
  const ffmpeg = findMediaTool('ffmpeg');
  const args = [
    '-x',
    '--audio-format',
    'mp3',
    '--postprocessor-args',
    'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
    '-o',
    out
  ];
  if (path.isAbsolute(ffmpeg)) args.push('--ffmpeg-location', path.dirname(ffmpeg));
  args.push(url);
  await run('yt-dlp', args);
  return path.join(workDir, `${safeID}.mp3`);
}

async function transcribeOpenAI(filePath: string, cfg: AppConfig['asr'], language: ASRLanguageCode): Promise<string> {
  if (!cfg.openai_api_key) throw new Error('OpenAI-compatible ASR API key is not configured');
  const data = await fs.readFile(filePath);
  const form = new FormData();
  form.append('model', cfg.model || 'whisper-1');
  form.append('file', new Blob([data]), path.basename(filePath));
  form.append('response_format', 'json');
  if (language !== 'auto') form.append('language', language);
  const res = await fetch(`${cfg.openai_base_url.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.openai_api_key}` },
    body: form
  });
  if (!res.ok) throw new Error(`OpenAI ASR HTTP ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { text?: string };
  if (!out.text?.trim()) throw new Error('OpenAI ASR returned empty text');
  return out.text.trim();
}

async function transcribeSpark(filePath: string, cfg: AppConfig['asr'], onProgress: ((message: string) => void) | undefined, language: ASRLanguageCode): Promise<string> {
  const appId = cfg.spark_app_id || '';
  const apiKey = cfg.spark_api_key || '';
  const apiSecret = cfg.spark_api_secret || '';
  if (!appId || !apiKey || !apiSecret) throw new Error('Spark IAT APPID/APIKey/APISecret is not configured');
  const duration = await probeDuration(filePath);
  const chunkSeconds = 55;
  const total = Math.max(1, Math.ceil(duration / chunkSeconds));
  const tempDir = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '-spark-iat');
  await fs.mkdir(tempDir, { recursive: true });
  const lines: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSeconds;
    const length = Math.min(chunkSeconds, Math.max(1, duration - start));
    const chunkPath = path.join(tempDir, `chunk-${String(index + 1).padStart(4, '0')}.pcm`);
    onProgress?.(`Preparing Spark IAT chunk ${index + 1}/${total}...`);
    await run(findMediaTool('ffmpeg'), [
      '-y',
      '-ss',
      start.toFixed(3),
      '-t',
      length.toFixed(3),
      '-i',
      filePath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      chunkPath
    ]);
    onProgress?.(`Recognizing Spark IAT chunk ${index + 1}/${total}...`);
    const text = await transcribeSparkIatChunk(chunkPath, cfg, language);
    if (text.trim()) lines.push(`[${start.toFixed(1)}-${(start + length).toFixed(1)}] ${text.trim()}`);
  }
  const content = lines.join('\n').trim();
  if (!content) throw new Error('Spark IAT returned empty transcript');
  return content;
}

async function transcribeSparkIatChunk(filePath: string, cfg: AppConfig['asr'], language: ASRLanguageCode): Promise<string> {
  const endpoint = sparkIatEndpoint(cfg);
  const url = signedXfyunWsUrl(endpoint, cfg.spark_api_key || '', cfg.spark_api_secret || '');
  const appId = cfg.spark_app_id || '';
  const audio = await fs.readFile(filePath);
  const WebSocketImpl = globalThis.WebSocket;
  if (!WebSocketImpl) throw new Error('WebSocket is not available in this Node.js runtime');
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    let result = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        reject(new Error('Spark IAT timeout'));
      }
    }, 90000);

    socket.addEventListener('open', async () => {
      try {
        const frameSize = 1280;
        const business = sparkIatBusiness(language);
        for (let offset = 0; offset < audio.length; offset += frameSize) {
          const frame = audio.subarray(offset, Math.min(offset + frameSize, audio.length));
          socket.send(JSON.stringify({
            common: { app_id: appId },
            business,
            data: {
              status: offset === 0 ? 0 : 1,
              format: 'audio/L16;rate=16000',
              encoding: 'raw',
              audio: frame.toString('base64')
            }
          }));
          await sleep(40);
        }
        socket.send(JSON.stringify({
          common: { app_id: appId },
          business,
          data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' }
        }));
      } catch (err) {
        settleReject(err);
      }
    });

    socket.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(String(event.data)) as SparkIatResponse;
        const code = data.code ?? data.header?.code ?? 0;
        if (code !== 0) throw new Error(`Spark IAT ${code}: ${data.message || data.header?.message || String(event.data)}`);
        result += parseSparkIatResult(data);
        if ((data.data?.status ?? data.header?.status) === 2) settleResolve(result.trim());
      } catch (err) {
        settleReject(err);
      }
    });

    socket.addEventListener('error', () => settleReject(new Error('Spark IAT WebSocket connection failed')));
    socket.addEventListener('close', () => {
      if (!settled) {
        result.trim() ? settleResolve(result.trim()) : settleReject(new Error('Spark IAT closed before returning text'));
      }
    });

    function settleResolve(value: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve(value);
    }

    function settleReject(err: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      reject(err);
    }
  });
}

type SparkIatResponse = {
  code?: number;
  message?: string;
  sid?: string;
  header?: { code?: number; message?: string; status?: number };
  data?: {
    status?: number;
    result?: {
      ws?: Array<{ cw?: Array<{ w?: string }> }>;
    };
  };
};

function parseSparkIatResult(data: SparkIatResponse): string {
  return (data.data?.result?.ws || [])
    .flatMap((item) => item.cw || [])
    .map((item) => item.w || '')
    .join('');
}

function sparkIatBusiness(language: ASRLanguageCode): Record<string, string | number> {
  return {
    language: language === 'zh' ? 'zh_cn' : 'mul_cn',
    domain: 'slm',
    accent: language === 'zh' ? 'mandarin' : 'mulacc',
    vad_eos: 60000
  };
}

function sparkIatEndpoint(cfg: AppConfig['asr']): string {
  if (cfg.openai_base_url?.startsWith('wss://')) return cfg.openai_base_url;
  return 'wss://iat-api.xfyun.cn/v2/iat';
}

function signedXfyunWsUrl(endpoint: string, apiKey: string, apiSecret: string): string {
  const parsed = new URL(endpoint);
  const host = parsed.host;
  const urlPath = parsed.pathname;
  const date = new Date().toUTCString();
  const signatureOrigin = 'host: ' + host + '\ndate: ' + date + '\nGET ' + urlPath + ' HTTP/1.1';
  const signature = crypto.createHmac('sha256', apiSecret).update(signatureOrigin).digest('base64');
  const authorizationOrigin = 'api_key="' + apiKey + '", algorithm="hmac-sha256", headers="host date request-line", signature="' + signature + '"';
  parsed.searchParams.set('authorization', Buffer.from(authorizationOrigin).toString('base64'));
  parsed.searchParams.set('date', date);
  parsed.searchParams.set('host', host);
  return parsed.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(findMediaTool('ffprobe'), [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with ${code}: ${stderr.trim()}`));
        return;
      }
      const duration = Number(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('ffprobe did not return a valid duration'));
        return;
      }
      resolve(duration);
    });
  });
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

function findMediaTool(name: 'ffmpeg' | 'ffprobe'): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    path.resolve(process.cwd(), 'tools', 'ffmpeg', 'bin', exe),
    path.resolve(process.cwd(), 'node_modules', '@remotion', 'compositor-win32-x64-msvc', exe),
    path.resolve(process.cwd(), '..', 'bilibili-study-notes-remotion', 'node_modules', '@remotion', 'compositor-win32-x64-msvc', exe),
    path.resolve(process.cwd(), '..', 'B站视频总结工具', 'node_modules', '@remotion', 'compositor-win32-x64-msvc', exe)
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || name;
}

function withMediaToolPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ffmpeg = findMediaTool('ffmpeg');
  if (!path.isAbsolute(ffmpeg)) return env;
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  const existing = env[key] || env.PATH || '';
  return { ...env, [key]: `${path.dirname(ffmpeg)}${path.delimiter}${existing}` };
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
            reject(new Error(event.message || 'Local ASR failed'));
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
        reject(new Error(`Local ASR exited with ${code}: ${stderr.trim()}`));
        return;
      }
      if (!finalContent.trim()) {
        reject(new Error(stderr.trim() || 'Local ASR returned empty text'));
        return;
      }
      resolve(finalContent.trim());
    });
  });
}
