import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../types.js';

export type VoiceCatalogItem = {
  id: string;
  name: string;
  provider: 'volcengine' | 'gpt_sovits';
  voice_type: string;
  gender: 'male' | 'female' | 'neutral';
  style: string[];
  description: string;
  cluster?: string;
};

type PreviewOptions = {
  provider?: string;
  voice_type: string;
  text: string;
  speed?: number;
  pitch?: number;
  volume?: number;
  emotion?: string;
  ref_audio_path?: string;
  prompt_text?: string;
  prompt_lang?: string;
};

type VolcengineSynthesizeOptions = {
  voice_type: string;
  text: string;
  speed: number;
  pitch: number;
  volume: number;
  emotion: string;
};

const DEFAULT_PREVIEW_TEXT = '我做了一个开源小工具，专门把 B站长教程变成能复习、能检索、能照着做的学习笔记。';

export const VOLCENGINE_VOICE_CATALOG: VoiceCatalogItem[] = [
  {
    id: 'local-gpt-sovits',
    name: '本地复刻音色',
    provider: 'gpt_sovits',
    voice_type: 'local_reference',
    gender: 'male',
    style: ['本地', '复刻', '男声', '搞怪'],
    description: '使用本地 GPT-SoVITS API 和参考音频生成，不消耗云端字数。'
  },
  {
    id: 'male-qingshuang',
    name: '清爽男声',
    provider: 'volcengine',
    voice_type: 'zh_male_qingshuangnanda_moon_bigtts',
    gender: 'male',
    style: ['男声', '清爽', '教程', '短视频'],
    description: '轻快清楚，适合产品教程和小红书口播。'
  },
  {
    id: 'male-yuanbo',
    name: '渊博小叔',
    provider: 'volcengine',
    voice_type: 'zh_male_yuanboxiaoshu_moon_bigtts',
    gender: 'male',
    style: ['男声', '知识感', '解说'],
    description: '成熟但不压嗓，适合知识型讲解。'
  },
  {
    id: 'male-jieshuo',
    name: '阳光解说男声',
    provider: 'volcengine',
    voice_type: 'zh_male_yangguangqingnian_moon_bigtts',
    gender: 'male',
    style: ['男声', '阳光', '解说', '短视频'],
    description: '更外放，适合教程开场和节奏较快的视频。'
  },
  {
    id: 'male-qingnian',
    name: '青年男声',
    provider: 'volcengine',
    voice_type: 'zh_male_qingnianda_moon_bigtts',
    gender: 'male',
    style: ['男声', '年轻', '自然'],
    description: '偏自然青年感，适合不太正式的口播。'
  },
  {
    id: 'male-aojiao',
    name: '傲娇男友',
    provider: 'volcengine',
    voice_type: 'zh_male_aojiaobazong_moon_bigtts',
    gender: 'male',
    style: ['男声', '情绪', '搞怪', '短视频'],
    description: '更有表演感，可以试作搞怪风格。'
  },
  {
    id: 'male-guangbo',
    name: '广播男声',
    provider: 'volcengine',
    voice_type: 'zh_male_guangboyuan_moon_bigtts',
    gender: 'male',
    style: ['男声', '播音', '正式'],
    description: '播音腔，适合正式视频，不适合太搞怪。'
  },
  {
    id: 'female-huopo',
    name: '活泼女声',
    provider: 'volcengine',
    voice_type: 'zh_female_huoponvsheng_moon_bigtts',
    gender: 'female',
    style: ['女声', '活泼', '短视频'],
    description: '节奏明快，适合小红书。'
  },
  {
    id: 'female-tianmei',
    name: '甜美女声',
    provider: 'volcengine',
    voice_type: 'zh_female_tianmeisongyue_moon_bigtts',
    gender: 'female',
    style: ['女声', '甜美', '口播'],
    description: '更柔和，适合轻松教程。'
  }
];

export class TTSProvider {
  constructor(private cfg: AppConfig['tts']) {}

  status() {
    return {
      provider: this.cfg.provider,
      configured: this.isConfigured(),
      cluster: this.cfg.cluster,
      endpoint: maskEndpoint(this.cfg.endpoint),
      default_voice_type: this.cfg.provider === 'gpt_sovits' ? 'local_reference' : this.cfg.voice_type || '',
      gpt_sovits_base_url: this.cfg.gpt_sovits_base_url || ''
    };
  }

  voices() {
    return VOLCENGINE_VOICE_CATALOG;
  }

  async preview(options: PreviewOptions) {
    const provider = options.provider || this.cfg.provider;
    if (provider === 'gpt_sovits') {
      return this.previewWithGPTSoVITS(options);
    }
    if (provider !== 'volcengine') throw new Error(`Unsupported TTS provider: ${provider}`);
    if (!this.isConfigured()) {
      throw new Error('火山 TTS 未配置：请设置 VOLCENGINE_TTS_APP_ID 和 VOLCENGINE_TTS_ACCESS_TOKEN');
    }
    const text = (options.text || DEFAULT_PREVIEW_TEXT).trim().slice(0, 220);
    if (!text) throw new Error('试听文本不能为空');
    const voiceType = options.voice_type || this.cfg.voice_type || '';
    if (!voiceType) throw new Error('voice_type is required');

    const data = await this.synthesize({
      voice_type: voiceType,
      text,
      speed: clampNumber(options.speed, 0.5, 2, 1.08),
      pitch: clampNumber(options.pitch, 0.5, 2, 1),
      volume: clampNumber(options.volume, 0.1, 3, 1),
      emotion: options.emotion || 'happy'
    });

    const id = randomUUID();
    const dir = path.join('notes', 'tts', 'previews');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.mp3`);
    await fs.writeFile(filePath, data);
    return {
      id,
      provider: 'volcengine',
      voice_type: voiceType,
      text,
      file_path: filePath,
      audio_url: `/files/tts/previews/${id}.mp3`
    };
  }

  private async previewWithGPTSoVITS(options: PreviewOptions) {
    const baseUrl = (this.cfg.gpt_sovits_base_url || 'http://127.0.0.1:9880').replace(/\/$/, '');
    const text = (options.text || DEFAULT_PREVIEW_TEXT).trim().slice(0, 500);
    const refAudioPath = (options.ref_audio_path || this.cfg.gpt_sovits_ref_audio_path || '').trim();
    const promptText = (options.prompt_text || this.cfg.gpt_sovits_prompt_text || '').trim();
    const promptLang = (options.prompt_lang || this.cfg.gpt_sovits_prompt_lang || 'zh').trim();
    if (!text) throw new Error('试听文本不能为空');
    if (!refAudioPath) throw new Error('请填写本地参考音频路径 ref_audio_path');
    if (!promptText) throw new Error('请填写参考音频对应文本 prompt_text');

    const response = await fetch(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        text_lang: 'zh',
        ref_audio_path: refAudioPath,
        prompt_text: promptText,
        prompt_lang: promptLang,
        text_split_method: 'cut5',
        batch_size: 1,
        media_type: 'wav',
        streaming_mode: false,
        speed_factor: clampNumber(options.speed, 0.5, 2, 1)
      })
    });

    if (!response.ok) {
      throw new Error(`GPT-SoVITS HTTP ${response.status}: ${await response.text()}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    const id = randomUUID();
    const dir = path.join('notes', 'tts', 'previews');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.wav`);
    await fs.writeFile(filePath, data);
    return {
      id,
      provider: 'gpt_sovits',
      voice_type: 'local_reference',
      text,
      file_path: filePath,
      audio_url: `/files/tts/previews/${id}.wav`
    };
  }

  private async synthesize(options: VolcengineSynthesizeOptions) {
    const appid = this.cfg.app_id || '';
    const token = this.cfg.access_token || '';
    const response = await fetch(this.cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer;${token}`
      },
      body: JSON.stringify({
        app: {
          appid,
          token,
          cluster: this.cfg.cluster
        },
        user: {
          uid: 'bilibili-study-notes-web'
        },
        audio: {
          voice_type: options.voice_type,
          encoding: 'mp3',
          rate: 24000,
          speed_ratio: options.speed,
          volume_ratio: options.volume,
          pitch_ratio: options.pitch,
          emotion: options.emotion,
          language: 'cn'
        },
        request: {
          reqid: randomUUID(),
          text: options.text,
          text_type: 'plain',
          operation: 'query'
        }
      })
    });

    if (!response.ok) {
      throw new Error(`火山 TTS HTTP ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { code?: number; message?: string; data?: string };
    if (body.code !== 3000 || !body.data) {
      throw new Error(`火山 TTS 失败：${body.code || 'unknown'} ${body.message || ''}`.trim());
    }
    return Buffer.from(body.data, 'base64');
  }

  private isConfigured() {
    if (this.cfg.provider === 'gpt_sovits') {
      return Boolean(this.cfg.gpt_sovits_base_url);
    }
    return Boolean(this.cfg.app_id && this.cfg.access_token && this.cfg.endpoint && this.cfg.cluster);
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function maskEndpoint(value: string) {
  return value.replace(/^https?:\/\//, '');
}
