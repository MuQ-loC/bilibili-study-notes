import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AudioOutlined,
  CameraOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  ConfigProvider,
  Descriptions,
  Empty,
  Flex,
  Form,
  Image,
  Input,
  InputNumber,
  Layout,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Tabs,
  Tag,
  Typography
} from 'antd';
import 'antd/dist/reset.css';
import './styles.css';

const { Header, Content } = Layout;
const { Text, Title } = Typography;
const { TextArea } = Input;

type Video = {
  id: string;
  url: string;
  bvid: string;
  cid: number;
  title: string;
  owner: string;
  cover_url: string;
  duration: number;
};

type Transcript = {
  content: string;
  source: string;
};

type Summary = {
  id: string;
  markdown: string;
  model: string;
};

type Note = {
  id: string;
  title: string;
  markdown: string;
  feishu_document_id: string;
};

type Screenshot = {
  id: string;
  timestamp: number;
  file_path: string;
  description: string;
};

type StreamPayload = {
  text?: string;
  message?: string;
  error?: string;
  report?: string;
  summary?: Summary;
  transcript?: Transcript;
  lesson?: CourseLesson;
};

type TTSVoice = {
  id: string;
  name: string;
  provider: string;
  voice_type: string;
  gender: 'male' | 'female' | 'neutral';
  style: string[];
  description: string;
};

type TTSStatus = {
  provider: string;
  configured: boolean;
  cluster: string;
  endpoint: string;
  default_voice_type: string;
  gpt_sovits_base_url?: string;
};

type TTSPreview = {
  id: string;
  provider: string;
  voice_type: string;
  text: string;
  audio_url: string;
};

type RuntimeConfig = {
  ai: {
    provider: 'openai_compatible' | 'deepseek' | 'ollama' | 'dify' | 'spark';
    base_url: string;
    model: string;
    api_key?: string;
    spark_app_id?: string;
    spark_api_key?: string;
    spark_api_secret?: string;
    api_key_configured?: boolean;
    spark_app_id_configured?: boolean;
    spark_api_key_configured?: boolean;
    spark_api_secret_configured?: boolean;
  };
  asr: {
    provider: 'none' | 'openai' | 'local';
    model: string;
    device: string;
    work_dir: string;
    python_path: string;
    openai_base_url: string;
    openai_api_key?: string;
    openai_api_key_configured?: boolean;
  };
};

type AppDraft = {
  url?: string;
  batchUrl?: string;
  batchLimit?: string;
  batchWorkers?: string;
  batchTranscribeMissing?: boolean;
  batchSkipCorrect?: boolean;
  video?: Video | null;
  transcript?: string;
  transcriptSource?: string;
  transcriptStatus?: string;
  instruction?: string;
  summary?: string;
  summaryStatus?: string;
  note?: Note | null;
  feishuTarget?: string;
};

type Course = {
  id: string;
  title: string;
  source_url: string;
  created_at: string;
  updated_at: string;
};

type CourseLesson = {
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

const APP_VERSION = '2026-06-10-antd-batch-1';
const DRAFT_KEY = 'bili_summary_workspace_draft_v1';
const DEFAULT_INSTRUCTION = '按学习教程笔记整理，提取操作步骤、命令、关键概念、易错点和复习清单。';

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

function cleanText(value: string | undefined | null): string {
  if (!value) return '';
  return value.replace(/\u0000/g, '').normalize('NFC');
}

function likelyNeedsCorrection(value: string): boolean {
  return /咖啡员哀|ComfoUI|康薄优艾|康伯优爱|看不于爱|看不如爱|诱门|照不开|掌控着|魔仙|模仙|彩阳器|螺瓦|鲜面|暴错|邏继|集产/.test(value);
}

function readDraft(): AppDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as AppDraft;
  } catch {
    return {};
  }
}

function buildFeishuSyncBody(noteID: string, target: string): Record<string, string> {
  const body: Record<string, string> = { note_id: noteID };
  const value = target.trim();
  if (!value) return body;
  if (/\/(?:drive\/)?folder\//.test(value)) {
    body.folder_url = value;
  } else {
    body.document_url = value;
  }
  return body;
}

function playerUrl(video: Video | null): string {
  if (!video) return '';
  return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(video.bvid)}&page=1&autoplay=0`;
}

function parseSSEMessage(raw: string): { event: string; payload: StreamPayload } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, payload: JSON.parse(dataLines.join('\n')) as StreamPayload };
}

function App() {
  const [initialDraft] = useState<AppDraft>(() => readDraft());
  const [url, setUrl] = useState(initialDraft.url || '');
  const [batchUrl, setBatchUrl] = useState(initialDraft.batchUrl || '');
  const [batchLimit, setBatchLimit] = useState(initialDraft.batchLimit || '0');
  const [batchWorkers, setBatchWorkers] = useState(initialDraft.batchWorkers || '2');
  const [batchTranscribeMissing, setBatchTranscribeMissing] = useState(initialDraft.batchTranscribeMissing || false);
  const [batchSkipCorrect, setBatchSkipCorrect] = useState(initialDraft.batchSkipCorrect || false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus, setBatchStatus] = useState('等待批量任务');
  const [batchLogs, setBatchLogs] = useState<string[]>([]);
  const [video, setVideo] = useState<Video | null>(initialDraft.video || null);
  const [transcript, setTranscript] = useState(initialDraft.transcript || '');
  const [transcriptSource, setTranscriptSource] = useState(initialDraft.transcriptSource || 'none');
  const [transcriptStatus, setTranscriptStatus] = useState(initialDraft.transcriptStatus || '解析视频后会自动获取字幕 / B站 AI 字幕。');
  const [instruction, setInstruction] = useState(initialDraft.instruction || DEFAULT_INSTRUCTION);
  const [summary, setSummary] = useState(initialDraft.summary || '');
  const [summaryStatus, setSummaryStatus] = useState(initialDraft.summaryStatus || '等待 AI 总结');
  const [summaryError, setSummaryError] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [note, setNote] = useState<Note | null>(initialDraft.note || null);
  const [feishuTarget, setFeishuTarget] = useState(initialDraft.feishuTarget || '');
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [status, setStatus] = useState('就绪');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ttsStatus, setTtsStatus] = useState<TTSStatus | null>(null);
  const [ttsVoices, setTtsVoices] = useState<TTSVoice[]>([]);
  const [voiceGender, setVoiceGender] = useState<'all' | 'male' | 'female'>('male');
  const [voiceStyle, setVoiceStyle] = useState('搞怪');
  const [selectedVoiceType, setSelectedVoiceType] = useState('');
  const [previewText, setPreviewText] = useState('我做了一个开源小工具，专门把 B站长教程变成能复习、能检索、能照着做的学习笔记。');
  const [ttsSpeed, setTtsSpeed] = useState(1.12);
  const [ttsPitch, setTtsPitch] = useState(1);
  const [ttsEmotion, setTtsEmotion] = useState('happy');
  const [localRefAudioPath, setLocalRefAudioPath] = useState('');
  const [localPromptText, setLocalPromptText] = useState('');
  const [localPromptLang, setLocalPromptLang] = useState('zh');
  const [ttsPreview, setTtsPreview] = useState<TTSPreview | null>(null);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsMessage, setTtsMessage] = useState('正在加载音色列表...');
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseID, setSelectedCourseID] = useState('');
  const [courseLessons, setCourseLessons] = useState<CourseLesson[]>([]);
  const [activeLessonID, setActiveLessonID] = useState('');
  const [courseLogs, setCourseLogs] = useState<string[]>([]);
  const [courseStatus, setCourseStatus] = useState('课程历史加载后，可以接着编辑、总结和保存笔记。');
  const [lessonTranscriptDraft, setLessonTranscriptDraft] = useState('');
  const [lessonSummaryDraft, setLessonSummaryDraft] = useState('');
  const [lessonBusy, setLessonBusy] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<RuntimeConfig | null>(null);
  const [configStatus, setConfigStatus] = useState('Loading model config...');
  const [configBusy, setConfigBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const currentPlayer = useMemo(() => playerUrl(video), [video]);
  const summaryWordCount = useMemo(() => summary.trim().length, [summary]);
  const transcriptWordCount = useMemo(() => transcript.trim().length, [transcript]);
  const voiceStyles = useMemo(
    () => Array.from(new Set(ttsVoices.flatMap((voice) => voice.style))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [ttsVoices]
  );
  const filteredVoices = useMemo(
    () =>
      ttsVoices.filter((voice) => {
        const genderMatched = voiceGender === 'all' || voice.gender === voiceGender;
        const styleMatched = !voiceStyle || voice.style.includes(voiceStyle);
        return genderMatched && styleMatched;
      }),
    [ttsVoices, voiceGender, voiceStyle]
  );
  const activeLesson = useMemo(
    () => courseLessons.find((item) => item.id === activeLessonID) || null,
    [courseLessons, activeLessonID]
  );

  useEffect(() => {
    api<{ status: TTSStatus; voices: TTSVoice[] }>('/api/tts/voices')
      .then((res) => {
        setTtsStatus(res.status);
        setTtsVoices(res.voices);
        const preferred =
          res.voices.find((voice) => voice.style.includes('搞怪') && voice.gender === 'male') ||
          res.voices.find((voice) => voice.gender === 'male') ||
          res.voices[0];
        setSelectedVoiceType(res.status.default_voice_type || preferred?.voice_type || '');
        setTtsMessage(res.status.configured ? '音色列表已加载，可以直接试听。' : '音色列表已加载；试听前需要配置火山 TTS AppID 和 Token。');
      })
      .catch((err) => {
        setTtsMessage(`音色列表加载失败：${(err as Error).message}`);
      });
  }, []);

  useEffect(() => {
    loadCourses();
    loadRuntimeConfig();
  }, []);

  useEffect(() => {
    const draft: AppDraft = {
      url,
      batchUrl,
      batchLimit,
      batchWorkers,
      batchTranscribeMissing,
      batchSkipCorrect,
      video,
      transcript,
      transcriptSource,
      transcriptStatus,
      instruction,
      summary,
      summaryStatus,
      note,
      feishuTarget
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Ignore browser storage failures.
    }
  }, [url, batchUrl, batchLimit, batchWorkers, batchTranscribeMissing, batchSkipCorrect, video, transcript, transcriptSource, transcriptStatus, instruction, summary, summaryStatus, note, feishuTarget]);

  function addLog(message: string) {
    setLog((items) => [`${new Date().toLocaleTimeString()} ${message}`, ...items].slice(0, 80));
  }

  function addBatchLog(message: string) {
    setBatchLogs((items) => [...items, `${new Date().toLocaleTimeString()} ${message}`].slice(-160));
  }

  function addCourseLog(message: string) {
    setCourseLogs((items) => [...items, `${new Date().toLocaleTimeString()} ${message}`].slice(-120));
  }

  async function loadRuntimeConfig() {
    try {
      const res = await api<RuntimeConfig>('/api/config');
      const draft = {
        ...res,
        ai: { ...res.ai, api_key: '', spark_app_id: '', spark_api_key: '', spark_api_secret: '' },
        asr: { ...res.asr, openai_api_key: '' }
      };
      setRuntimeConfig(res);
      setConfigDraft(draft);
      setConfigStatus('Model config loaded');
    } catch (err) {
      setConfigStatus(`Load failed: ${(err as Error).message}`);
    }
  }

  function patchConfig(section: 'ai' | 'asr', key: string, value: string) {
    setConfigDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        [section]: {
          ...current[section],
          [key]: value
        }
      } as RuntimeConfig;
    });
  }

  async function saveRuntimeConfig() {
    if (!configDraft) return;
    setConfigBusy(true);
    setConfigStatus('Saving model config...');
    try {
      const saved = await api<RuntimeConfig>('/api/config', configDraft);
      const draft = {
        ...saved,
        ai: { ...saved.ai, api_key: '', spark_app_id: '', spark_api_key: '', spark_api_secret: '' },
        asr: { ...saved.asr, openai_api_key: '' }
      };
      setRuntimeConfig(saved);
      setConfigDraft(draft);
      setConfigStatus('Saved. New model config is active.');
    } catch (err) {
      setConfigStatus(`Save failed: ${(err as Error).message}`);
    } finally {
      setConfigBusy(false);
    }
  }

  async function loadCourses() {
    try {
      const res = await api<{ courses: Course[] }>('/api/courses');
      setCourses(res.courses);
      if (!selectedCourseID && res.courses[0]) {
        await loadCourse(res.courses[0].id);
      }
    } catch (err) {
      setCourseStatus(`课程历史加载失败：${(err as Error).message}`);
    }
  }

  async function loadCourse(courseID: string) {
    const res = await api<{ course: Course; lessons: CourseLesson[] }>(`/api/courses/${courseID}`);
    setSelectedCourseID(res.course.id);
    setCourseLessons(res.lessons);
    const first = res.lessons[0];
    setActiveLessonID(first?.id || '');
    loadLessonDraft(first || null);
    setCourseStatus(`已加载：${res.course.title} / ${res.lessons.length} 课时`);
  }

  async function recoverAsrCache() {
    setLessonBusy(true);
    setCourseStatus('正在扫描 notes/asr 本地音频缓存...');
    try {
      const res = await api<{ recovered: number; courses: Course[] }>('/api/courses/recover-asr-cache', {});
      setCourses(res.courses);
      if (res.courses[0]) await loadCourse(res.courses[0].id);
      setCourseStatus(`已恢复 ${res.recovered} 个本地 ASR 缓存课时`);
    } catch (err) {
      setCourseStatus(`恢复缓存失败：${(err as Error).message}`);
    } finally {
      setLessonBusy(false);
    }
  }

  function loadLessonDraft(lesson: CourseLesson | null) {
    if (!lesson) {
      setLessonTranscriptDraft('');
      setLessonSummaryDraft('');
      return;
    }
    setLessonTranscriptDraft(lesson.corrected_transcript?.content || lesson.transcript?.content || '');
    setLessonSummaryDraft(lesson.summary?.markdown || '');
  }

  async function saveLessonDraft() {
    if (!activeLesson) return;
    setLessonBusy(true);
    try {
      const transcriptPayload = {
        source: activeLesson.corrected_transcript?.source || 'manual_edit',
        language: 'zh-CN',
        content: lessonTranscriptDraft
      };
      const summaryPayload = activeLesson.summary
        ? { ...activeLesson.summary, markdown: lessonSummaryDraft }
        : lessonSummaryDraft.trim()
          ? { id: '', video_id: activeLesson.video?.id || '', model: 'manual', markdown: lessonSummaryDraft }
          : undefined;
      const updated = await api<CourseLesson>(`/api/course-lessons/${activeLesson.id}`, {
        corrected_transcript: transcriptPayload,
        summary: summaryPayload
      });
      setCourseLessons((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setCourseStatus('课时内容已保存');
    } catch (err) {
      setCourseStatus(`保存失败：${(err as Error).message}`);
    } finally {
      setLessonBusy(false);
    }
  }

  function replaceCourseLesson(updated: CourseLesson) {
    setCourseLessons((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    if (updated.id === activeLessonID) {
      setLessonTranscriptDraft(updated.corrected_transcript?.content || updated.transcript?.content || '');
      setLessonSummaryDraft(updated.summary?.markdown || '');
    }
  }

  async function streamLessonAction(endpoint: string, body: Record<string, unknown>, doneMessage: string) {
    if (!activeLesson) return;
    setLessonBusy(true);
    setCourseLogs([]);
    setCourseStatus('Lesson task started...');
    addCourseLog('POST ' + endpoint);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText || 'stream endpoint returned no body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handleMessage = (raw: string) => {
        const parsed = parseSSEMessage(raw);
        if (!parsed) return;
        const { event, payload } = parsed;
        if (event === 'status' || event === 'progress' || event === 'log') {
          const message = payload.message || 'Working...';
          setCourseStatus(message);
          addCourseLog(message);
          return;
        }
        if (event === 'done') {
          if (payload.lesson) replaceCourseLesson(payload.lesson);
          const message = payload.message || doneMessage;
          setCourseStatus(message);
          addCourseLog(message);
          return;
        }
        if (event === 'error') {
          throw new Error(payload.error || 'Lesson task failed');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (part.trim()) handleMessage(part);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleMessage(buffer);
    } catch (err) {
      const message = 'Failed: ' + (err as Error).message;
      setCourseStatus(message);
      addCourseLog(message);
    } finally {
      setLessonBusy(false);
    }
  }

  async function downloadActiveLessonAudio() {
    if (!activeLesson) return;
    await streamLessonAction('/api/course-lessons/' + activeLesson.id + '/download-audio/stream', {}, 'Audio download finished');
  }

  async function transcribeActiveLesson() {
    if (!activeLesson) return;
    await streamLessonAction('/api/course-lessons/' + activeLesson.id + '/transcribe/stream', { correct: true }, 'Transcription and correction finished');
  }

  async function summarizeActiveLesson() {
    if (!activeLesson) return;
    await streamLessonAction('/api/course-lessons/' + activeLesson.id + '/summarize/stream', {
      transcript: lessonTranscriptDraft,
      instruction
    }, 'Summary finished');
  }

  async function runActiveLesson() {
    if (!activeLesson) return;
    await streamLessonAction('/api/course-lessons/' + activeLesson.id + '/run/stream', {
      transcript: lessonTranscriptDraft.trim() ? lessonTranscriptDraft : '',
      instruction,
      correct: true
    }, 'Single lesson run finished');
  }

  async function saveActiveLessonNote() {
    if (!activeLesson) return;
    setLessonBusy(true);
    try {
      const updated = await api<CourseLesson>(`/api/course-lessons/${activeLesson.id}/note`, {
        title: activeLesson.video?.title || `课时${activeLesson.index}`,
        markdown: lessonSummaryDraft
      });
      setCourseLessons((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setCourseStatus(`笔记已保存：${updated.note?.id || ''}`);
    } catch (err) {
      setCourseStatus(`保存笔记失败：${(err as Error).message}`);
    } finally {
      setLessonBusy(false);
    }
  }

  async function syncActiveLessonFeishu() {
    if (!activeLesson) return;
    setLessonBusy(true);
    setCourseStatus('正在保存到飞书文件夹...');
    try {
      const updated = await api<CourseLesson>(
        `/api/course-lessons/${activeLesson.id}/feishu`,
        {
          ...buildFeishuSyncBody(activeLesson.note?.id || '', feishuTarget),
          title: activeLesson.video?.title || `课时${activeLesson.index}`,
          markdown: lessonSummaryDraft
        }
      );
      setCourseLessons((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setCourseStatus(`已保存到飞书：${updated.note?.feishu_document_id || '完成'}`);
    } catch (err) {
      setCourseStatus(`飞书保存失败：${(err as Error).message}`);
    } finally {
      setLessonBusy(false);
    }
  }

  async function previewVoice(voiceType = selectedVoiceType) {
    if (!voiceType) {
      setTtsMessage('请先选择一个音色');
      return;
    }
    setTtsLoading(true);
    setTtsPreview(null);
    setTtsMessage('正在生成试听音频...');
    try {
      const preview = await api<TTSPreview>('/api/tts/preview', {
        provider: voiceType === 'local_reference' ? 'gpt_sovits' : 'volcengine',
        voice_type: voiceType,
        text: previewText,
        speed: ttsSpeed,
        pitch: ttsPitch,
        emotion: ttsEmotion,
        ref_audio_path: localRefAudioPath,
        prompt_text: localPromptText,
        prompt_lang: localPromptLang
      });
      setSelectedVoiceType(voiceType);
      setTtsPreview(preview);
      setTtsMessage(`试听生成完成：${voiceType}`);
      addLog(`配音试听生成：${voiceType}`);
    } catch (err) {
      const message = (err as Error).message;
      setTtsMessage(`试听失败：${message}`);
      addLog(`配音试听失败：${message}`);
    } finally {
      setTtsLoading(false);
    }
  }

  function useVoiceForVideo(voiceType: string) {
    setSelectedVoiceType(voiceType);
    setTtsMessage(`已选中音色：${voiceType}。生成视频配音时会使用这个 voice_type。`);
  }

  async function analyze() {
    const targetURL = url.trim();
    if (!targetURL) {
      setStatus('请先输入 B 站视频链接');
      return;
    }
    setBusy(true);
    setStatus('解析中：正在读取 B 站视频信息...');
    addLog(`开始解析：${targetURL}`);
    try {
      const res = await api<{ video: Video; transcript: Transcript }>('/api/videos/analyze', { url: targetURL });
      const text = cleanText(res.transcript?.content);
      setVideo(res.video);
      setTranscript(text);
      setTranscriptSource(res.transcript?.source || 'none');
      setTranscriptStatus(text ? `已自动获取：${res.transcript?.source || '字幕'}` : '没有拿到公开字幕；如果视频需要登录，请配置 BILIBILI_COOKIE 后重新解析。');
      setSummary('');
      setSummaryStatus('等待 AI 总结');
      setSummaryError('');
      setNote(null);
      setScreenshots([]);
      addLog(`已解析：${cleanText(res.video.title)}`);
      setStatus(`已解析：${cleanText(res.video.title)}`);
      if (!text) addLog('未获取到字幕：公开视频字幕为空，或该视频需要登录态 Cookie 才能读取 B站 AI 字幕。');
    } catch (err) {
      const message = (err as Error).message;
      addLog(`解析失败：${message}`);
      setStatus(`解析失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadTranscriptFromBackend(): Promise<string> {
    if (!video) throw new Error('请先解析一个 B 站视频');
    const sourceURL = video.url || video.bvid;
    setTranscriptStatus('正在自动获取字幕 / B站 AI 字幕...');
    addLog('正在自动获取字幕 / B站 AI 字幕。');
    const res = await api<{ video: Video; transcript: Transcript }>('/api/videos/analyze', { url: sourceURL });
    const text = cleanText(res.transcript?.content);
    setVideo(res.video);
    setTranscript(text);
    setTranscriptSource(res.transcript?.source || 'none');
    if (!text.trim()) {
      const message = '自动字幕没有拿到。这个视频可能没有公开字幕，或需要在 config.json / BILIBILI_COOKIE 配置 B站登录 Cookie 后重新解析。';
      setTranscriptStatus(message);
      throw new Error(message);
    }
    setTranscriptStatus(`已自动获取：${res.transcript?.source || '字幕'}`);
    addLog(`字幕已获取：${res.transcript?.source || '字幕'}`);
    return text;
  }

  async function refreshTranscript() {
    if (!video) return;
    setBusy(true);
    try {
      await loadTranscriptFromBackend();
    } catch (err) {
      addLog(`字幕获取失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function transcribeFromBackend(): Promise<string> {
    if (!video) throw new Error('请先解析一个 B 站视频');
    setTranscriptStatus('正在本机自动转写：准备下载音频...');
    addLog('本机自动转写已启动。');

    let finalText = '';
    const res = await fetch('/api/videos/transcribe/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: video.id })
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText || '本机转写接口没有返回内容流');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handleMessage = (raw: string) => {
      const parsed = parseSSEMessage(raw);
      if (!parsed) return;
      const { event, payload } = parsed;
      if (event === 'status' || event === 'progress') {
        setTranscriptStatus(payload.message || '正在本机自动转写...');
        return;
      }
      if (event === 'done') {
        finalText = cleanText(payload.transcript?.content);
        setTranscript(finalText);
        setTranscriptSource(payload.transcript?.source || 'local_asr');
        setTranscriptStatus(`本机转写完成：${finalText.length} 字`);
        addLog(`本机转写完成：${finalText.length} 字`);
        return;
      }
      if (event === 'error') {
        throw new Error(payload.error || '本机转写失败');
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (part.trim()) handleMessage(part);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleMessage(buffer);
    if (!finalText.trim()) throw new Error('本机转写结束，但没有生成文本');
    return finalText;
  }

  async function startTranscribe() {
    if (!video) return;
    setBusy(true);
    try {
      await transcribeFromBackend();
    } catch (err) {
      const message = (err as Error).message;
      setTranscriptStatus(`本机转写失败：${message}`);
      addLog(`本机转写失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function correctTranscriptFromBackend(sourceText?: string): Promise<string> {
    if (!video) throw new Error('请先解析一个 B 站视频');
    const inputText = sourceText ?? transcript;
    if (!inputText.trim()) throw new Error('没有可校正的字幕/转写文本');
    setTranscriptStatus('正在 AI 校正文稿...');
    addLog('AI 文稿校正已启动。');

    let generated = '';
    let finalText = '';
    const res = await fetch('/api/transcripts/correct/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: video.id, transcript: inputText })
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText || 'AI 校正接口没有返回内容流');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handleMessage = (raw: string) => {
      const parsed = parseSSEMessage(raw);
      if (!parsed) return;
      const { event, payload } = parsed;
      if (event === 'status') {
        setTranscriptStatus(payload.message || '正在 AI 校正文稿...');
        return;
      }
      if (event === 'delta') {
        const text = cleanText(payload.text);
        if (!text) return;
        generated += text;
        setTranscript(generated);
        setTranscriptStatus(`正在校正文稿：${generated.length} 字`);
        return;
      }
      if (event === 'done') {
        finalText = cleanText(payload.transcript?.content);
        if (finalText) {
          setTranscript(finalText);
          setTranscriptSource(payload.transcript?.source || 'ai_corrected');
        }
        setTranscriptStatus(`文稿校正完成：${finalText.length} 字 / ${payload.transcript?.source || 'ai_corrected'}`);
        addLog(`文稿校正完成：${finalText.length} 字`);
        return;
      }
      if (event === 'error') {
        throw new Error(payload.error || 'AI 校正失败');
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || '';
      for (const part of parts) {
        if (part.trim()) handleMessage(part);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleMessage(buffer);
    if (!finalText.trim()) throw new Error('AI 校正结束，但没有生成文稿');
    return finalText;
  }

  async function startCorrectTranscript() {
    if (!video) return;
    setBusy(true);
    try {
      await correctTranscriptFromBackend();
    } catch (err) {
      const message = (err as Error).message;
      setTranscriptStatus(`AI 校正失败：${message}`);
      addLog(`AI 校正失败：${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function summarize() {
    if (!video) {
      setSummaryStatus('请先解析一个 B 站视频');
      return;
    }
    let transcriptText = transcript;
    if (!transcriptText.trim()) {
      try {
        transcriptText = await loadTranscriptFromBackend();
      } catch (err) {
        addLog(`字幕接口未拿到文本，开始本机转写：${(err as Error).message}`);
        try {
          transcriptText = await transcribeFromBackend();
        } catch (transcribeErr) {
          const message = (transcribeErr as Error).message;
          setSummaryError(message);
          setSummaryStatus(`AI 总结未启动：${message}`);
          addLog(message);
          return;
        }
      }
    }
    if (transcriptText.trim() && (transcriptSource === 'local_asr' || likelyNeedsCorrection(transcriptText))) {
      try {
        transcriptText = await correctTranscriptFromBackend(transcriptText);
      } catch (err) {
        addLog(`文稿校正跳过：${(err as Error).message}`);
      }
    }

    setBusy(true);
    setStreaming(true);
    setSummary('');
    setSummaryError('');
    setSummaryStatus('AI 总结中：正在连接模型...');
    addLog('AI 总结已启动，等待流式返回。');

    let generated = '';
    try {
      const res = await fetch('/api/summaries/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: video.id,
          transcript: transcriptText,
          instruction
        })
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText || 'AI 总结接口没有返回内容流');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleMessage = (raw: string) => {
        const parsed = parseSSEMessage(raw);
        if (!parsed) return;
        const { event, payload } = parsed;
        if (event === 'status') {
          setSummaryStatus(payload.message || 'AI 总结中...');
          return;
        }
        if (event === 'delta') {
          const text = cleanText(payload.text);
          if (!text) return;
          generated += text;
          setSummary(generated);
          setSummaryStatus(`AI 总结中：已生成 ${generated.length} 字`);
          return;
        }
        if (event === 'done') {
          const finalSummary = payload.summary;
          if (finalSummary?.markdown) {
            generated = finalSummary.markdown;
            setSummary(cleanText(finalSummary.markdown));
          }
          setSummaryStatus(`AI 总结完成：${finalSummary?.model || 'unknown model'}`);
          addLog(`AI 总结完成：${finalSummary?.model || 'unknown model'}`);
          return;
        }
        if (event === 'error') {
          throw new Error(payload.error || 'AI 总结失败');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (part.trim()) handleMessage(part);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleMessage(buffer);
      if (!generated.trim()) {
        setSummaryStatus('AI 总结结束，但没有生成正文。');
      }
    } catch (err) {
      const message = (err as Error).message;
      setSummaryError(message);
      setSummary(`总结失败：${message}`);
      setSummaryStatus(`AI 总结失败：${message}`);
      addLog(`总结失败：${message}`);
    } finally {
      setBusy(false);
      setStreaming(false);
    }
  }

  async function saveCurrentNote(): Promise<Note> {
    if (!video) throw new Error('请先解析一个 B 站视频');
    if (!summary.trim()) throw new Error('没有可保存的学习笔记');
    const res = await api<Note>('/api/notes', {
      video_id: video.id,
      title: video.title,
      markdown: summary
    });
    setNote(res);
    addLog('笔记已保存到本地 notes 目录。');
    return res;
  }

  async function saveNote() {
    setBusy(true);
    try {
      await saveCurrentNote();
    } catch (err) {
      addLog(`保存失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function syncFeishuNote(targetNote: Note): Promise<Note> {
    const target = feishuTarget.trim();
    const res = await api<Note>('/api/feishu/sync', buildFeishuSyncBody(targetNote.id, target));
    setNote(res);
    addLog(`已同步飞书：${res.feishu_document_id || '完成'}`);
    return res;
  }

  async function syncFeishu() {
    if (!note) return;
    setBusy(true);
    try {
      await syncFeishuNote(note);
    } catch (err) {
      const message = (err as Error).message;
      if (/note not found/i.test(message)) {
        try {
          addLog('笔记状态已过期，重新保存后重试飞书同步。');
          const freshNote = await saveCurrentNote();
          await syncFeishuNote(freshNote);
        } catch (retryErr) {
          addLog(`飞书同步失败：${(retryErr as Error).message}`);
        }
      } else {
        addLog(`飞书同步失败：${message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function startBatchSummary() {
    const targetURL = batchUrl.trim() || url.trim();
    if (!targetURL) {
      setBatchStatus('请先输入 B 站合集/专辑链接');
      return;
    }
    const limit = Math.max(0, Number.parseInt(batchLimit, 10) || 0);
    const workers = Math.max(1, Math.min(8, Number.parseInt(batchWorkers, 10) || 2));
    setBatchRunning(true);
    setBatchStatus(`批量任务启动中：workers=${workers}${limit ? `，limit=${limit}` : ''}`);
    setBatchLogs([]);
    addLog(`批量总结启动：workers=${workers}${limit ? `，limit=${limit}` : ''}`);

    try {
      const res = await fetch('/api/batch/album/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: targetURL,
          target: feishuTarget.trim(),
          instruction,
          limit,
          workers,
          transcribe_missing: batchTranscribeMissing,
          skip_correct: batchSkipCorrect
        })
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || res.statusText || '批量接口没有返回内容流');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const handleMessage = (raw: string) => {
        const parsed = parseSSEMessage(raw);
        if (!parsed) return;
        const { event, payload } = parsed;
        if (event === 'status') {
          setBatchStatus(payload.message || '批量任务运行中...');
          return;
        }
        if (event === 'log') {
          const message = cleanText(payload.message);
          if (!message) return;
          addBatchLog(message);
          if (message.startsWith('[album]') || message.startsWith('[error]') || message.startsWith('[report]')) {
            setBatchStatus(message);
          }
          return;
        }
        if (event === 'done') {
          setBatchStatus(payload.message || '批量任务完成');
          addBatchLog(payload.report ? `报告：${payload.report}` : '批量任务完成');
          addLog('批量总结完成。');
          return;
        }
        if (event === 'error') {
          throw new Error(payload.error || '批量任务失败');
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() || '';
        for (const part of parts) {
          if (part.trim()) handleMessage(part);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleMessage(buffer);
    } catch (err) {
      const message = (err as Error).message;
      setBatchStatus(`批量任务失败：${message}`);
      addBatchLog(`失败：${message}`);
      addLog(`批量总结失败：${message}`);
    } finally {
      setBatchRunning(false);
    }
  }

  async function startCapture() {
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      setStream(media);
      if (videoRef.current) videoRef.current.srcObject = media;
      addLog('屏幕捕获已启动。');
    } catch (err) {
      addLog(`屏幕捕获失败：${(err as Error).message}`);
    }
  }

  async function captureFrame() {
    if (!video || !stream || !videoRef.current) {
      addLog('请先点击“开始屏幕捕获”。');
      return;
    }
    const el = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth || 1280;
    canvas.height = el.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL('image/png');
    try {
      const res = await api<Screenshot>('/api/screenshots', {
        video_id: video.id,
        note_id: note?.id || '',
        timestamp: 0,
        image_data_url: dataURL,
        description: 'manual screenshot'
      });
      setScreenshots((items) => [res, ...items]);
      addLog('截图已保存。');
    } catch (err) {
      addLog(`截图保存失败：${(err as Error).message}`);
    }
  }

  const singleVideoPane = (
    <Row gutter={[16, 16]} align="stretch">
      <Col xs={24} xl={12}>
        <Space direction="vertical" size={16} className="full">
          <Card
            title="视频解析"
            extra={<Tag color={status.startsWith('解析失败') ? 'red' : 'blue'}>{status}</Tag>}
          >
            <Space.Compact className="full">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPressEnter={analyze}
                placeholder="https://www.bilibili.com/video/BV..."
              />
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={analyze} loading={busy && status.startsWith('解析中')} disabled={busy || !url.trim()}>
                解析
              </Button>
            </Space.Compact>
            {video && (
              <Descriptions className="videoMeta" size="small" column={1} bordered>
                <Descriptions.Item label="标题">{video.title}</Descriptions.Item>
                <Descriptions.Item label="UP">{video.owner || '-'}</Descriptions.Item>
                <Descriptions.Item label="BVID">{video.bvid}</Descriptions.Item>
              </Descriptions>
            )}
          </Card>

          <Card title="播放器" bodyStyle={{ padding: 0 }}>
            {currentPlayer ? (
              <iframe className="playerFrame" src={currentPlayer} allow="autoplay; fullscreen" />
            ) : (
              <div className="emptyPane"><VideoCameraOutlined />等待视频链接</div>
            )}
          </Card>
        </Space>
      </Col>

      <Col xs={24} xl={12}>
        <Space direction="vertical" size={16} className="full">
          <Card
            title="字幕 / 转写"
            extra={<Tag color={transcriptSource === 'none' ? 'default' : 'green'}>{transcriptSource}</Tag>}
          >
            <Flex gap={8} wrap="wrap" className="toolbar">
              <Button icon={<ReloadOutlined />} onClick={refreshTranscript} disabled={busy || !video}>
                获取字幕
              </Button>
              <Button icon={<AudioOutlined />} onClick={startTranscribe} disabled={busy || !video}>
                自动转写
              </Button>
              <Button icon={<RobotOutlined />} onClick={startCorrectTranscript} disabled={busy || !video || !transcript.trim()}>
                AI 校正
              </Button>
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={summarize} loading={streaming} disabled={busy || !video || streaming}>
                AI 总结
              </Button>
            </Flex>
            <Alert className="compactAlert" type="info" showIcon message={transcriptStatus} />
            <TextArea className="workText" value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="字幕 / 转写文本" />
            <Flex justify="space-between" align="center" className="subbar">
              <Text type="secondary">{transcriptWordCount} 字</Text>
              <Text type="secondary">校正后再总结</Text>
            </Flex>
          </Card>

          <Card title="截图记录">
            <Flex gap={8} wrap="wrap" className="toolbar">
              <Button icon={<CameraOutlined />} onClick={startCapture}>开始屏幕捕获</Button>
              <Button icon={<FileTextOutlined />} onClick={captureFrame} disabled={!video}>手动截图</Button>
            </Flex>
            <video className="capturePreview" ref={videoRef} autoPlay muted playsInline />
            <div className="miniList">
              {screenshots.length === 0 ? <Text type="secondary">暂无截图</Text> : screenshots.map((shot) => <div key={shot.id}>{shot.description} · {shot.file_path}</div>)}
            </div>
          </Card>
        </Space>
      </Col>

      <Col xs={24} xl={14}>
        <Card
          title="学习笔记"
          extra={
            <Space>
              <Button icon={<SaveOutlined />} onClick={saveNote} disabled={busy || !video || !summary.trim()}>
                保存
              </Button>
              <Button icon={<CloudUploadOutlined />} onClick={syncFeishu} disabled={busy || !note}>
                飞书
              </Button>
            </Space>
          }
        >
          <Alert className="compactAlert" type={summaryError ? 'error' : streaming ? 'info' : 'success'} showIcon message={summaryStatus} />
          <Input
            className="stackGap"
            value={feishuTarget}
            onChange={(e) => setFeishuTarget(e.target.value)}
            placeholder="飞书文档或文件夹链接"
          />
          <TextArea className="noteText" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="AI 总结结果" />
          <Flex justify="space-between" align="center" className="subbar">
            <Text type="secondary">{summaryWordCount} 字</Text>
            <Text type="secondary">{note ? `本地笔记：${note.id}` : '未保存'}</Text>
          </Flex>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card title="提示词">
          <TextArea className="instructionText" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        </Card>
        <Card className="logCard" title="运行日志">
          <div className="logList">
            {log.length === 0 ? <Text type="secondary">暂无日志</Text> : log.map((item, index) => <div key={index}>{item}</div>)}
          </div>
        </Card>
      </Col>
    </Row>
  );

  const batchPane = (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={9}>
        <Card title="批量任务" extra={<Tag color={batchRunning ? 'processing' : 'default'}>{batchRunning ? '运行中' : '空闲'}</Tag>}>
          <Form layout="vertical">
            <Form.Item label="合集/专辑链接">
              <Input value={batchUrl} onChange={(e) => setBatchUrl(e.target.value)} placeholder="留空则使用单视频链接输入框" />
            </Form.Item>
            <Form.Item label="飞书目标">
              <Input value={feishuTarget} onChange={(e) => setFeishuTarget(e.target.value)} placeholder="飞书文件夹或文档链接" />
            </Form.Item>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item label="并发数">
                  <InputNumber className="full" min={1} max={8} value={Number(batchWorkers)} onChange={(value) => setBatchWorkers(String(value ?? 2))} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="数量限制">
                  <InputNumber className="full" min={0} value={Number(batchLimit)} onChange={(value) => setBatchLimit(String(value ?? 0))} />
                </Form.Item>
              </Col>
            </Row>
            <Space direction="vertical" className="full checkGroup">
              <Checkbox checked={batchTranscribeMissing} onChange={(e) => setBatchTranscribeMissing(e.target.checked)}>无字幕时本机转写</Checkbox>
              <Checkbox checked={batchSkipCorrect} onChange={(e) => setBatchSkipCorrect(e.target.checked)}>跳过 AI 字幕校正</Checkbox>
            </Space>
            <Button className="full runButton" type="primary" size="large" icon={<FolderOpenOutlined />} onClick={startBatchSummary} loading={batchRunning}>
              一键批量总结
            </Button>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={15}>
        <Space direction="vertical" size={16} className="full">
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Card>
                <Statistic title="并发数" value={Number(batchWorkers) || 2} suffix="路" />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card>
                <Statistic title="限制数量" value={Number(batchLimit) || 0} suffix={Number(batchLimit) ? '条' : '不限'} />
              </Card>
            </Col>
            <Col xs={24} md={8}>
              <Card>
                <Statistic title="日志行数" value={batchLogs.length} />
              </Card>
            </Col>
          </Row>
          <Card title="批量状态">
            <Alert type={batchStatus.startsWith('批量任务失败') || batchStatus.startsWith('[error]') ? 'error' : batchRunning ? 'info' : 'success'} showIcon message={batchStatus} />
          </Card>
          <Card title="批量日志">
            <pre className="batchLog">{batchLogs.length ? batchLogs.join('\n') : '等待任务输出'}</pre>
          </Card>
        </Space>
      </Col>
    </Row>
  );

  const voicePane = (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={8}>
        <Space direction="vertical" size={16} className="full">
          <Card title="火山 TTS 配置" extra={<Tag color={ttsStatus?.configured ? 'green' : 'red'}>{ttsStatus?.configured ? '已配置' : '未配置'}</Tag>}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Provider">{ttsStatus?.provider || '-'}</Descriptions.Item>
              <Descriptions.Item label="Cluster">{ttsStatus?.cluster || '-'}</Descriptions.Item>
              <Descriptions.Item label="Endpoint">{ttsStatus?.endpoint || '-'}</Descriptions.Item>
              <Descriptions.Item label="GPT-SoVITS">{ttsStatus?.gpt_sovits_base_url || '-'}</Descriptions.Item>
              <Descriptions.Item label="默认音色">{ttsStatus?.default_voice_type || '未设置'}</Descriptions.Item>
            </Descriptions>
            <Alert
              className="compactAlert topGap"
              type={ttsStatus?.configured ? 'success' : 'warning'}
              showIcon
              message={ttsMessage}
            />
          </Card>

          <Card title="试听参数">
            <Form layout="vertical">
              <Form.Item label="筛选性别">
                <Select
                  value={voiceGender}
                  onChange={setVoiceGender}
                  options={[
                    { value: 'male', label: '男声' },
                    { value: 'female', label: '女声' },
                    { value: 'all', label: '全部' }
                  ]}
                />
              </Form.Item>
              <Form.Item label="筛选风格">
                <Select
                  value={voiceStyle}
                  onChange={setVoiceStyle}
                  allowClear
                  placeholder="全部风格"
                  options={voiceStyles.map((style) => ({ value: style, label: style }))}
                />
              </Form.Item>
              <Form.Item label="当前 voice_type">
                <Input value={selectedVoiceType} onChange={(e) => setSelectedVoiceType(e.target.value)} />
              </Form.Item>
              <Form.Item label="本地参考音频路径">
                <Input
                  value={localRefAudioPath}
                  onChange={(e) => setLocalRefAudioPath(e.target.value)}
                  placeholder="D:\\path\\reference.wav 或 GPT-SoVITS 可访问的相对路径"
                />
              </Form.Item>
              <Form.Item label="参考音频对应文本">
                <TextArea
                  className="previewText"
                  value={localPromptText}
                  onChange={(e) => setLocalPromptText(e.target.value)}
                  placeholder="参考音频里实际说的文字，必须尽量准确"
                />
              </Form.Item>
              <Form.Item label="参考语言">
                <Select
                  value={localPromptLang}
                  onChange={setLocalPromptLang}
                  options={[
                    { value: 'zh', label: '中文 zh' },
                    { value: 'en', label: '英文 en' },
                    { value: 'ja', label: '日文 ja' },
                    { value: 'all_zh', label: '多语种中文 all_zh' }
                  ]}
                />
              </Form.Item>
              <Form.Item label={`语速 ${ttsSpeed.toFixed(2)}`}>
                <Slider min={0.6} max={1.8} step={0.01} value={ttsSpeed} onChange={setTtsSpeed} />
              </Form.Item>
              <Form.Item label={`音高 ${ttsPitch.toFixed(2)}`}>
                <Slider min={0.6} max={1.6} step={0.01} value={ttsPitch} onChange={setTtsPitch} />
              </Form.Item>
              <Form.Item label="情绪">
                <Select
                  value={ttsEmotion}
                  onChange={setTtsEmotion}
                  options={[
                    { value: 'happy', label: 'happy / 活泼' },
                    { value: 'angry', label: 'angry / 更冲' },
                    { value: 'surprised', label: 'surprised / 夸张' },
                    { value: 'neutral', label: 'neutral / 自然' }
                  ]}
                />
              </Form.Item>
              <Form.Item label="试听文本">
                <TextArea className="previewText" value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
              </Form.Item>
              <Button className="full" type="primary" icon={<AudioOutlined />} loading={ttsLoading} onClick={() => previewVoice()}>
                试听当前音色
              </Button>
            </Form>
          </Card>
        </Space>
      </Col>

      <Col xs={24} xl={16}>
        <Space direction="vertical" size={16} className="full">
          <Card title="音色列表" extra={<Tag color="blue">{filteredVoices.length} / {ttsVoices.length}</Tag>}>
            {filteredVoices.length === 0 ? (
              <Empty description="没有匹配的音色" />
            ) : (
              <div className="voiceGrid">
                {filteredVoices.map((voice) => (
                  <Card
                    key={voice.id}
                    size="small"
                    className={voice.voice_type === selectedVoiceType ? 'voiceCard activeVoice' : 'voiceCard'}
                    title={voice.name}
                    extra={<Tag color={voice.gender === 'male' ? 'blue' : voice.gender === 'female' ? 'magenta' : 'default'}>{voice.gender}</Tag>}
                  >
                    <div className="voiceType">{voice.voice_type}</div>
                    <Text type="secondary">{voice.description}</Text>
                    <div className="voiceTags">
                      {voice.style.map((style) => <Tag key={style}>{style}</Tag>)}
                    </div>
                    <Flex gap={8} wrap="wrap">
                      <Button size="small" onClick={() => useVoiceForVideo(voice.voice_type)}>选中</Button>
                      <Button size="small" type="primary" ghost icon={<AudioOutlined />} loading={ttsLoading && selectedVoiceType === voice.voice_type} onClick={() => previewVoice(voice.voice_type)}>
                        试听
                      </Button>
                    </Flex>
                  </Card>
                ))}
              </div>
            )}
          </Card>

          <Card title="试听结果">
            {ttsPreview ? (
              <Space direction="vertical" size={10} className="full">
                <Alert type="success" showIcon message={ttsPreview.voice_type} description={ttsPreview.text} />
                <audio className="audioPlayer" src={ttsPreview.audio_url} controls autoPlay />
              </Space>
            ) : (
              <Empty description="点击任意音色试听后，这里会出现播放器" />
            )}
          </Card>
        </Space>
      </Col>
    </Row>
  );

  const coursePane = (
    <Row gutter={[16, 16]}>
      <Col xs={24} xl={8}>
        <Space direction="vertical" size={16} className="full">
          <Card
            title="课程历史"
            extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadCourses}>刷新</Button>}
          >
            <Select
              className="full"
              placeholder="选择课程"
              value={selectedCourseID || undefined}
              onChange={loadCourse}
              options={courses.map((course) => ({
                value: course.id,
                label: course.title
              }))}
            />
            <Space className="topGap" wrap>
              <Button size="small" icon={<ReloadOutlined />} onClick={loadCourses}>刷新</Button>
              <Button size="small" icon={<FolderOpenOutlined />} loading={lessonBusy} onClick={recoverAsrCache}>恢复缓存</Button>
            </Space>
            <Input
              className="topGap"
              value={feishuTarget}
              onChange={(event) => setFeishuTarget(event.target.value)}
              placeholder="飞书文件夹或文档链接"
            />
            <Alert className="compactAlert topGap" type={courseStatus.startsWith('失败') || courseStatus.includes('失败') ? 'error' : 'info'} showIcon message={courseStatus} />
          </Card>

          <Card title="课时列表" extra={<Tag color="blue">{courseLessons.length}</Tag>}>
            <div className="lessonList">
              {courseLessons.length === 0 ? (
                <Empty description="暂无课程记录" />
              ) : (
                courseLessons.map((lesson) => (
                  <button
                    key={lesson.id}
                    type="button"
                    className={lesson.id === activeLessonID ? 'lessonItem activeLessonItem' : 'lessonItem'}
                    onClick={() => {
                      setActiveLessonID(lesson.id);
                      loadLessonDraft(lesson);
                    }}
                  >
                    <span className="lessonTitle">
                      {String(lesson.index).padStart(2, '0')} {lesson.video?.title || lesson.url}
                    </span>
                    <span className="lessonMeta">
                      <Tag color={lesson.status === 'done' ? 'green' : lesson.status === 'error' ? 'red' : lesson.status === 'cached' ? 'gold' : 'processing'}>{lesson.status}</Tag>
                      {lesson.note ? <Tag color="purple">已存笔记</Tag> : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </Card>
        </Space>
      </Col>

      <Col xs={24} xl={16}>
        {activeLesson ? (
          <Space direction="vertical" size={16} className="full">
            <Card
              title={activeLesson.video?.title || `课时 ${activeLesson.index}`}
              extra={
                <Space wrap>
                  <Button icon={<DownloadOutlined />} loading={lessonBusy} onClick={downloadActiveLessonAudio}>
                    {'\u4e0b\u8f7d\u97f3\u9891'}
                  </Button>
                  <Button icon={<AudioOutlined />} loading={lessonBusy} onClick={transcribeActiveLesson}>
                    {'\u8f6c\u5199\u5e76\u4f18\u5316'}
                  </Button>
                  <Button type="primary" icon={<ThunderboltOutlined />} loading={lessonBusy} onClick={runActiveLesson}>
                    {'\u4e00\u952e\u8dd1\u672c\u8bfe'}
                  </Button>
                  <Button icon={<FileTextOutlined />} loading={lessonBusy} onClick={summarizeActiveLesson}>
                    {'\u7ee7\u7eed\u603b\u7ed3'}
                  </Button>
                  <Button icon={<SaveOutlined />} loading={lessonBusy} onClick={saveLessonDraft}>
                    {'\u4fdd\u5b58\u4fee\u6539'}
                  </Button>
                  <Button icon={<CloudUploadOutlined />} loading={lessonBusy} disabled={!lessonSummaryDraft.trim()} onClick={syncActiveLessonFeishu}>
                    {'\u5b58\u98de\u4e66'}
                  </Button>
                </Space>
              }
            >
              <Descriptions size="small" bordered column={1}>
                <Descriptions.Item label="URL">{activeLesson.url}</Descriptions.Item>
                <Descriptions.Item label="状态">{activeLesson.status}</Descriptions.Item>
                <Descriptions.Item label="错误">{activeLesson.error || '-'}</Descriptions.Item>
                <Descriptions.Item label="更新时间">{activeLesson.updated_at}</Descriptions.Item>
              </Descriptions>
            </Card>

            <Card title={'\u8bfe\u65f6\u8fdb\u5ea6'} extra={<Tag color={lessonBusy ? 'processing' : 'default'}>{lessonBusy ? 'running' : 'idle'}</Tag>}>
              <Alert className="compactAlert" type={courseStatus.startsWith('Failed') || courseStatus.includes('\u5931\u8d25') ? 'error' : 'info'} showIcon message={courseStatus} />
              <pre className="courseLog">
                {courseLogs.length ? courseLogs.join('\n') : '\u7b49\u5f85\u8bfe\u65f6\u4efb\u52a1...'}
              </pre>
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} xl={12}>
                <Card title="字幕 / 校正文稿">
                  <TextArea
                    className="courseText"
                    value={lessonTranscriptDraft}
                    onChange={(event) => setLessonTranscriptDraft(event.target.value)}
                    placeholder="这里会保留原始字幕、ASR 转写或你手动修正后的文稿"
                  />
                </Card>
              </Col>
              <Col xs={24} xl={12}>
                <Card title="总结 / 笔记">
                  <TextArea
                    className="courseText"
                    value={lessonSummaryDraft}
                    onChange={(event) => setLessonSummaryDraft(event.target.value)}
                    placeholder="这里会保留 AI 总结，你可以继续编辑后保存成笔记"
                  />
                </Card>
              </Col>
            </Row>
          </Space>
        ) : (
          <Card>
            <Empty description="请选择一个课程课时" />
          </Card>
        )}
      </Col>
    </Row>
  );

  const settingsPane = (
    <Space direction="vertical" size={16} className="full settingsPane">
      <Alert
        type={configStatus.startsWith('Save failed') || configStatus.startsWith('Load failed') ? 'error' : 'info'}
        showIcon
        message={configStatus}
        description={'\u8fd9\u91cc\u4fee\u6539\u672c\u673a config.json\uff0c\u4fdd\u5b58\u540e\u7acb\u5373\u751f\u6548\u3002\u5bc6\u94a5\u6846\u7559\u7a7a\u5c31\u4fdd\u7559\u539f\u914d\u7f6e\u3002'}
        action={<Button type="primary" loading={configBusy} onClick={saveRuntimeConfig}>{'\u4fdd\u5b58\u8bbe\u7f6e\u5e76\u7acb\u5373\u751f\u6548'}</Button>}
      />
      {configDraft ? (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}>
              <Card title={'\u4e00\u3001\u603b\u7ed3\u6a21\u578b'} extra={<Tag color="blue">AI</Tag>}>
                <Form layout="vertical">
                  <Form.Item label={'\u6a21\u578b\u670d\u52a1\u5546'}>
                    <Select
                      value={configDraft.ai.provider}
                      onChange={(value) => patchConfig('ai', 'provider', value)}
                      options={[
                        { value: 'spark', label: '\u8baf\u98de\u661f\u706b Spark' },
                        { value: 'openai_compatible', label: 'OpenAI \u517c\u5bb9\u63a5\u53e3' },
                        { value: 'deepseek', label: 'DeepSeek' },
                        { value: 'ollama', label: 'Ollama \u672c\u5730\u6a21\u578b' },
                        { value: 'dify', label: 'Dify \u5e94\u7528' }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label={'\u603b\u7ed3\u6a21\u578b\u540d'}>
                    <Input
                      value={configDraft.ai.model}
                      onChange={(event) => patchConfig('ai', 'model', event.target.value)}
                      placeholder="generalv3.5 / 4.0Ultra / deepseek-chat / gpt-4o-mini"
                    />
                  </Form.Item>
                  <Form.Item label={'\u63a5\u53e3\u5730\u5740'}>
                    <Input
                      value={configDraft.ai.base_url}
                      onChange={(event) => patchConfig('ai', 'base_url', event.target.value)}
                      placeholder="Spark WebSocket can be empty; OpenAI-compatible uses /v1 URL"
                    />
                  </Form.Item>
                  <Form.Item label={'\u901a\u7528 API Key' + (runtimeConfig?.ai.api_key_configured ? '\uff08\u5df2\u914d\u7f6e\uff09' : '')}>
                    <Input.Password
                      value={configDraft.ai.api_key || ''}
                      onChange={(event) => patchConfig('ai', 'api_key', event.target.value)}
                      placeholder="DeepSeek / OpenAI-compatible key; leave blank to keep current key"
                    />
                  </Form.Item>
                </Form>
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card title={'\u4e8c\u3001\u661f\u706b\u4e13\u7528\u5bc6\u94a5'} extra={<Tag color={configDraft.ai.provider === 'spark' ? 'green' : 'default'}>{configDraft.ai.provider === 'spark' ? '\u5f53\u524d\u4f7f\u7528' : '\u53ef\u9009'}</Tag>}>
                <Form layout="vertical">
                  <Form.Item label={'Spark APPID' + (runtimeConfig?.ai.spark_app_id_configured ? '\uff08\u5df2\u914d\u7f6e\uff09' : '')}>
                    <Input.Password value={configDraft.ai.spark_app_id || ''} onChange={(event) => patchConfig('ai', 'spark_app_id', event.target.value)} placeholder="Leave blank to keep current APPID" />
                  </Form.Item>
                  <Form.Item label={'Spark APIKey' + (runtimeConfig?.ai.spark_api_key_configured ? '\uff08\u5df2\u914d\u7f6e\uff09' : '')}>
                    <Input.Password value={configDraft.ai.spark_api_key || ''} onChange={(event) => patchConfig('ai', 'spark_api_key', event.target.value)} placeholder="Leave blank to keep current APIKey" />
                  </Form.Item>
                  <Form.Item label={'Spark APISecret' + (runtimeConfig?.ai.spark_api_secret_configured ? '\uff08\u5df2\u914d\u7f6e\uff09' : '')}>
                    <Input.Password value={configDraft.ai.spark_api_secret || ''} onChange={(event) => patchConfig('ai', 'spark_api_secret', event.target.value)} placeholder="Leave blank to keep current APISecret" />
                  </Form.Item>
                </Form>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} xl={12}>
              <Card title={'\u4e09\u3001\u8f6c\u5199\u6a21\u578b\uff08Whisper / ASR\uff09'} extra={<Tag color="gold">{'\u5b57\u5e55\u8f6c\u5199'}</Tag>}>
                <Form layout="vertical">
                  <Form.Item label={'\u8f6c\u5199\u65b9\u5f0f'}>
                    <Select
                      value={configDraft.asr.provider}
                      onChange={(value) => patchConfig('asr', 'provider', value)}
                      options={[
                        { value: 'local', label: '\u672c\u5730 faster-whisper' },
                        { value: 'openai', label: '\u4e91\u7aef OpenAI \u517c\u5bb9 ASR' },
                        { value: 'none', label: '\u5173\u95ed\u8f6c\u5199' }
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label={'Whisper / ASR \u6a21\u578b'}>
                    <Input
                      value={configDraft.asr.model}
                      onChange={(event) => patchConfig('asr', 'model', event.target.value)}
                      placeholder="Local model path, or cloud model name like whisper-1"
                    />
                  </Form.Item>
                  <Row gutter={[8, 8]}>
                    <Col xs={24} md={8}>
                      <Form.Item label={'\u8fd0\u884c\u8bbe\u5907'}>
                        <Select
                          value={configDraft.asr.device || 'auto'}
                          onChange={(value) => patchConfig('asr', 'device', value)}
                          options={[
                            { value: 'auto', label: '\u81ea\u52a8' },
                            { value: 'cuda', label: 'CUDA / \u663e\u5361' },
                            { value: 'cpu', label: 'CPU' }
                          ]}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={16}>
                      <Form.Item label={'\u97f3\u9891\u7f13\u5b58\u76ee\u5f55'}>
                        <Input value={configDraft.asr.work_dir} onChange={(event) => patchConfig('asr', 'work_dir', event.target.value)} placeholder="notes/asr" />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item label={'\u672c\u5730 Python \u73af\u5883'}>
                    <Input value={configDraft.asr.python_path} onChange={(event) => patchConfig('asr', 'python_path', event.target.value)} placeholder="D:\\Ev\\BiliSummaryASR\\Scripts\\python.exe" />
                  </Form.Item>
                </Form>
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card title={'\u56db\u3001\u4e91\u7aef ASR \u8ba4\u8bc1'} extra={<Tag color={configDraft.asr.provider === 'openai' ? 'green' : 'default'}>{configDraft.asr.provider === 'openai' ? '\u5f53\u524d\u4f7f\u7528' : '\u53ef\u9009'}</Tag>}>
                <Form layout="vertical">
                  <Form.Item label={'\u4e91\u7aef ASR \u63a5\u53e3\u5730\u5740'}>
                    <Input value={configDraft.asr.openai_base_url} onChange={(event) => patchConfig('asr', 'openai_base_url', event.target.value)} placeholder="https://api.openai.com/v1" />
                  </Form.Item>
                  <Form.Item label={'\u4e91\u7aef ASR API Key' + (runtimeConfig?.asr.openai_api_key_configured ? '\uff08\u5df2\u914d\u7f6e\uff09' : '')}>
                    <Input.Password value={configDraft.asr.openai_api_key || ''} onChange={(event) => patchConfig('asr', 'openai_api_key', event.target.value)} placeholder="Leave blank to keep current key" />
                  </Form.Item>
                  <Descriptions size="small" bordered column={1}>
                    <Descriptions.Item label={'\u5f53\u524d\u603b\u7ed3\u6a21\u578b'}>{runtimeConfig?.ai.provider || '-'} / {runtimeConfig?.ai.model || '-'}</Descriptions.Item>
                    <Descriptions.Item label={'\u5f53\u524d\u8f6c\u5199\u6a21\u578b'}>{runtimeConfig?.asr.provider || '-'} / {runtimeConfig?.asr.model || '-'}</Descriptions.Item>
                    <Descriptions.Item label={'\u5f53\u524d\u8f6c\u5199\u8bbe\u5907'}>{runtimeConfig?.asr.device || '-'}</Descriptions.Item>
                  </Descriptions>
                </Form>
              </Card>
            </Col>
          </Row>
        </>
      ) : (
        <Card>
          <Empty description="Loading model config" />
        </Card>
      )}
    </Space>
  );

  const dashboard = (
    <div className="dashboard">
      <Card className="heroPanel">
        <Flex justify="space-between" align="flex-start" gap={18} wrap="wrap">
          <div className="heroCopy">
            <Tag color="blue">本地优先 / BYOK / 可同步飞书</Tag>
            <Title level={2} className="heroTitle">B站教程学习笔记工作台</Title>
            <Text className="heroDesc">
              从 B站链接到字幕校正、学习笔记、合集并发和配音试听，所有高频操作集中在一个页面里。
            </Text>
          </div>
          <Space size={10} wrap>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={analyze} disabled={!url.trim() || busy}>
              解析当前链接
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={startBatchSummary} disabled={batchRunning || !(batchUrl || url).trim()}>
              跑合集
            </Button>
            <Button icon={<AudioOutlined />} onClick={() => previewVoice()} loading={ttsLoading}>
              试听配音
            </Button>
          </Space>
        </Flex>
      </Card>

      <Row gutter={[12, 12]} className="metricRow">
        <Col xs={12} md={6}>
          <Card size="small" className="metricCard">
            <Statistic title="当前视频" value={video ? 1 : 0} suffix="个" />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" className="metricCard">
            <Statistic title="字幕字数" value={transcriptWordCount} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" className="metricCard">
            <Statistic title="笔记字数" value={summaryWordCount} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" className="metricCard">
            <Statistic title="音色数量" value={ttsVoices.length} />
          </Card>
        </Col>
      </Row>
    </div>
  );

  return (
    <ConfigProvider
      theme={{
        token: {
          borderRadius: 6,
          colorPrimary: '#2563eb',
          fontFamily: '"Microsoft YaHei", "Segoe UI", system-ui, sans-serif'
        }
      }}
    >
      <Layout className="appShell">
        <Header className="appHeader">
          <div>
            <Title level={4} className="appTitle">B站视频总结工具</Title>
            <Text type="secondary">API 127.0.0.1:8791 · Web 127.0.0.1:8792</Text>
          </div>
          <Space>
            <Tag color={busy || streaming || batchRunning ? 'processing' : 'success'}>
              {busy || streaming || batchRunning ? '运行中' : '就绪'}
            </Tag>
            <Tag color="blue">{APP_VERSION}</Tag>
          </Space>
        </Header>
        <Content className="appContent">
          {dashboard}
          <Tabs
            defaultActiveKey="single"
            size="large"
            type="card"
            className="workspaceTabs"
            items={[
              { key: 'single', label: <span><VideoCameraOutlined /> 单视频工作台</span>, children: singleVideoPane },
              { key: 'batch', label: <span><FolderOpenOutlined /> 合集/专辑批量</span>, children: batchPane },
              { key: 'courses', label: <span><FileTextOutlined /> 课程管理</span>, children: coursePane },
              { key: 'voice', label: <span><AudioOutlined /> {'\u914d\u97f3\u97f3\u8272'}</span>, children: voicePane },
              { key: 'settings', label: <span><RobotOutlined /> {'\u8bbe\u7f6e'}</span>, children: settingsPane }
            ]}
          />
        </Content>
      </Layout>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
