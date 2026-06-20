export type Video = {
  id: string;
  url: string;
  bvid: string;
  cid: number;
  title: string;
  owner: string;
  cover_url: string;
  duration: number;
};

export type Transcript = {
  id?: string;
  video_id?: string;
  source: string;
  language: string;
  content: string;
};

export type Summary = {
  id: string;
  video_id: string;
  model: string;
  markdown: string;
};

export type Note = {
  id: string;
  video_id: string;
  title: string;
  markdown: string;
  feishu_document_id: string;
  created_at: string;
  updated_at: string;
};

export type Course = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
};

export type CourseLesson = {
  id: string;
  course_id: string;
  index: number;
  url: string;
  status: 'queued' | 'cached' | 'analyzing' | 'transcribing' | 'correcting' | 'summarizing' | 'done' | 'error';
  error: string;
  audio_path?: string;
  video?: Video;
  transcript?: Transcript;
  corrected_transcript?: Transcript;
  summary?: Summary;
  note?: Note;
  created_at: string;
  updated_at: string;
};

export type FeishuTarget = {
  document_id?: string;
  document_url?: string;
  folder_token?: string;
  folder_url?: string;
};

export type AppConfig = {
  server: {
    host: string;
    port: number;
  };
  bilibili: {
    cookie?: string;
    cookie_env: string;
  };
  ai: {
    provider: 'openai_compatible' | 'deepseek' | 'ollama' | 'dify';
    base_url: string;
    api_key?: string;
    api_key_env?: string;
    model: string;
    dify_app_type?: 'chat' | 'completion';
    dify_user?: string;
  };
  asr: {
    provider: 'none' | 'openai' | 'local';
    openai_base_url: string;
    openai_api_key?: string;
    openai_api_key_env?: string;
    model: string;
    work_dir: string;
    python_path?: string;
    python_path_env?: string;
    device?: string;
  };
  feishu: {
    enabled: boolean;
    enabled_env?: string;
    app_id?: string;
    app_id_env?: string;
    app_secret?: string;
    app_secret_env?: string;
    folder_token?: string;
    folder_token_env?: string;
    document_id?: string;
    document_id_env?: string;
  };
  tts: {
    provider: 'none' | 'volcengine' | 'gpt_sovits';
    app_id?: string;
    app_id_env?: string;
    access_token?: string;
    access_token_env?: string;
    cluster: string;
    endpoint: string;
    voice_type?: string;
    voice_type_env?: string;
    gpt_sovits_base_url?: string;
    gpt_sovits_ref_audio_path?: string;
    gpt_sovits_prompt_text?: string;
    gpt_sovits_prompt_lang?: string;
  };
};
