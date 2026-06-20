import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AppConfig, Transcript, Video } from '../types.js';

export class ASRProvider {
  constructor(private cfg: AppConfig['asr']) {}

  async transcribe(video: Video, onProgress?: (message: string) => void): Promise<Transcript> {
    if (this.cfg.provider === 'none') {
      throw new Error('ASR 未启用。请配置 ASR_PROVIDER=local/openai，或使用 B站公开字幕。');
    }
    if (this.cfg.provider === 'local') return this.transcribeLocal(video, onProgress);
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
    if (this.cfg.provider !== 'local') {
      throw new Error('cached audio transcription requires local ASR');
    }
    return this.transcribeLocal(video, onProgress, audioPath);
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
