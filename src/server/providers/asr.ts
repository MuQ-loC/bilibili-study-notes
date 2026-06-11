import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AppConfig, Transcript, Video } from '../types.js';

export class ASRProvider {
  constructor(private cfg: AppConfig['asr']) {}

  async transcribe(video: Video, onProgress?: (message: string) => void): Promise<Transcript> {
    if (this.cfg.provider === 'none') {
      throw new Error('ASR 未启用。请配置 asr.provider=openai，或使用 B站公开字幕。');
    }
    if (this.cfg.provider !== 'openai') {
      throw new Error(`暂不支持 ASR provider: ${this.cfg.provider}`);
    }
    if (!this.cfg.openai_api_key) throw new Error('未配置 OPENAI_API_KEY');
    await fs.mkdir(this.cfg.work_dir, { recursive: true });
    onProgress?.('正在用 yt-dlp 提取音频...');
    const audioPath = await downloadAudio(video.url, this.cfg.work_dir, video.bvid);
    onProgress?.('正在上传到 OpenAI Transcription API...');
    const text = await transcribeOpenAI(audioPath, this.cfg);
    return { source: `openai_asr/${this.cfg.model}`, language: 'zh-CN', content: text };
  }
}

async function downloadAudio(url: string, workDir: string, bvid: string): Promise<string> {
  const out = path.join(workDir, `${bvid}.%(ext)s`);
  await run('yt-dlp', ['-x', '--audio-format', 'mp3', '-o', out, url]);
  return path.join(workDir, `${bvid}.mp3`);
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

