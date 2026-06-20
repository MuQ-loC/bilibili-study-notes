import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './types.js';

const defaultConfig: AppConfig = {
  server: { host: '127.0.0.1', port: 8791 },
  bilibili: { cookie_env: 'BILIBILI_COOKIE' },
  ai: {
    provider: 'openai_compatible',
    base_url: 'https://api.shqbb.com/v1',
    api_key_env: 'NEWAPI_API_KEY',
    model: 'gpt-5.5',
    spark_app_id_env: 'SPARK_APP_ID',
    spark_api_key_env: 'SPARK_API_KEY',
    spark_api_secret_env: 'SPARK_API_SECRET',
    dify_app_type: 'chat',
    dify_user: 'bilibili-study-notes'
  },
  asr: {
    provider: 'spark',
    openai_base_url: 'https://api.openai.com/v1',
    openai_api_key_env: 'OPENAI_API_KEY',
    spark_app_id_env: 'SPARK_APP_ID',
    spark_api_secret_env: 'SPARK_API_SECRET',
    model: 'lfasr',
    work_dir: 'notes/asr',
    python_path: 'D:\\Ev\\BiliSummaryASR\\Scripts\\python.exe',
    python_path_env: 'LOCAL_ASR_PYTHON',
    device: 'auto'
  },
  feishu: {
    enabled: false,
    enabled_env: 'FEISHU_ENABLED',
    app_id_env: 'FEISHU_APP_ID',
    app_secret_env: 'FEISHU_APP_SECRET',
    folder_token_env: 'FEISHU_FOLDER_TOKEN',
    document_id_env: 'FEISHU_DOCUMENT_ID'
  },
  tts: {
    provider: 'gpt_sovits',
    app_id_env: 'VOLCENGINE_TTS_APP_ID',
    access_token_env: 'VOLCENGINE_TTS_ACCESS_TOKEN',
    cluster: 'volcano_tts',
    endpoint: 'https://openspeech.bytedance.com/api/v1/tts',
    voice_type_env: 'VOLCENGINE_TTS_VOICE_TYPE',
    gpt_sovits_base_url: 'http://127.0.0.1:9880',
    gpt_sovits_prompt_lang: 'zh'
  }
};

export function loadConfig(file = 'config.json'): AppConfig {
  const configPath = path.resolve(file);
  const rawText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '') : '';
  const raw = rawText ? JSON.parse(rawText) : {};
  const cfg = merge(defaultConfig, raw) as AppConfig;

  if (process.env.HOST) cfg.server.host = process.env.HOST;
  if (process.env.PORT && Number.isFinite(Number(process.env.PORT))) cfg.server.port = Number(process.env.PORT);

  cfg.bilibili.cookie ||= env(cfg.bilibili.cookie_env);
  cfg.ai.api_key ||= cfg.ai.api_key_env ? env(cfg.ai.api_key_env) : '';
  cfg.ai.spark_app_id ||= cfg.ai.spark_app_id_env ? env(cfg.ai.spark_app_id_env) : '';
  cfg.ai.spark_api_key ||= cfg.ai.spark_api_key_env ? env(cfg.ai.spark_api_key_env) : '';
  cfg.ai.spark_api_secret ||= cfg.ai.spark_api_secret_env ? env(cfg.ai.spark_api_secret_env) : '';
  if (env('ASR_PROVIDER')) cfg.asr.provider = env('ASR_PROVIDER') as AppConfig['asr']['provider'];
  if (env('ASR_MODEL')) cfg.asr.model = env('ASR_MODEL');
  if (env('LOCAL_ASR_MODEL')) cfg.asr.model = env('LOCAL_ASR_MODEL');
  if (env('LOCAL_ASR_DEVICE')) cfg.asr.device = env('LOCAL_ASR_DEVICE');
  cfg.asr.python_path ||= cfg.asr.python_path_env ? env(cfg.asr.python_path_env) : '';
  if (env('LOCAL_ASR_PYTHON')) cfg.asr.python_path = env('LOCAL_ASR_PYTHON');
  if (env('OPENAI_BASE_URL')) cfg.asr.openai_base_url = env('OPENAI_BASE_URL');
  cfg.asr.openai_api_key ||= cfg.asr.openai_api_key_env ? env(cfg.asr.openai_api_key_env) : '';
  cfg.asr.spark_app_id ||= cfg.asr.spark_app_id_env ? env(cfg.asr.spark_app_id_env) : '';
  cfg.asr.spark_api_secret ||= cfg.asr.spark_api_secret_env ? env(cfg.asr.spark_api_secret_env) : '';
  cfg.asr.spark_app_id ||= cfg.ai.spark_app_id;
  cfg.asr.spark_api_secret ||= cfg.ai.spark_api_secret;

  if (cfg.feishu.enabled_env && env(cfg.feishu.enabled_env)) {
    cfg.feishu.enabled = ['1', 'true', 'yes', 'on'].includes(env(cfg.feishu.enabled_env).toLowerCase());
  }
  cfg.feishu.app_id ||= cfg.feishu.app_id_env ? env(cfg.feishu.app_id_env) : '';
  cfg.feishu.app_secret ||= cfg.feishu.app_secret_env ? env(cfg.feishu.app_secret_env) : '';
  cfg.feishu.folder_token ||= cfg.feishu.folder_token_env ? env(cfg.feishu.folder_token_env) : '';
  cfg.feishu.document_id ||= cfg.feishu.document_id_env ? env(cfg.feishu.document_id_env) : '';
  cfg.tts.app_id ||= cfg.tts.app_id_env ? env(cfg.tts.app_id_env) : '';
  cfg.tts.access_token ||= cfg.tts.access_token_env ? env(cfg.tts.access_token_env) : '';
  cfg.tts.voice_type ||= cfg.tts.voice_type_env ? env(cfg.tts.voice_type_env) : '';
  return cfg;
}

function env(name?: string): string {
  return name ? process.env[name]?.trim() || '' : '';
}

function merge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) return patch ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? merge(out[key], value) : value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
