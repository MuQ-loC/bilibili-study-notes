import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { MemoryStore } from './store.js';
import type { AIServiceConfig, AppConfig, CourseLesson, Note, Transcript, Video } from './types.js';
import { AIProvider } from './providers/ai.js';
import { ASRProvider } from './providers/asr.js';
import { BilibiliClient, extractBvid } from './providers/bilibili.js';
import { FeishuProvider } from './providers/feishu.js';
import { TTSProvider } from './providers/tts.js';

const configFile = process.env.CONFIG_PATH || 'config.json';
let cfg = loadConfig(configFile);
const app = express();
const store = new MemoryStore();
const bilibili = new BilibiliClient(cfg.bilibili);
let ai = new AIProvider(cfg.ai);
let asr = new ASRProvider(cfg.asr);
const feishu = new FeishuProvider(cfg.feishu);
const tts = new TTSProvider(cfg.tts);

app.use(express.json({ limit: '30mb' }));
app.use('/files', express.static('notes'));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/config', asyncHandler(async (_req, res) => {
  res.json(publicConfig());
}));

app.post('/api/config', asyncHandler(async (req, res) => {
  const next = mergeRuntimeConfig(cfg, req.body || {});
  await saveRuntimeConfig(next);
  cfg = loadConfig(configFile);
  ai = new AIProvider(cfg.ai);
  asr = new ASRProvider(cfg.asr);
  res.json(publicConfig());
}));

app.get('/api/tts/voices', asyncHandler(async (_req, res) => {
  res.json({
    status: tts.status(),
    voices: tts.voices()
  });
}));

app.post('/api/tts/preview', asyncHandler(async (req, res) => {
  const preview = await tts.preview({
    provider: String(req.body.provider || ''),
    voice_type: String(req.body.voice_type || ''),
    text: String(req.body.text || ''),
    speed: Number(req.body.speed || 1.08),
    pitch: Number(req.body.pitch || 1),
    volume: Number(req.body.volume || 1),
    emotion: String(req.body.emotion || 'happy'),
    ref_audio_path: String(req.body.ref_audio_path || ''),
    prompt_text: String(req.body.prompt_text || ''),
    prompt_lang: String(req.body.prompt_lang || 'zh')
  });
  res.json(preview);
}));

app.post('/api/videos/analyze', asyncHandler(async (req, res) => {
  const { video, transcript } = await bilibili.analyze(String(req.body.url || ''));
  await store.saveVideo(video);
  if (transcript.content.trim()) await store.saveTranscript(video.id, transcript);
  res.json({ video, transcript });
}));

app.post('/api/videos/transcribe/stream', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const language = normalizeASRLanguage(req.body.language) || cfg.asr.language || 'foreign';
  sse(res, async (send) => {
    const transcript = await asr.transcribe(video, (message) => send('progress', { message }), { language });
    const saved = await store.saveTranscript(video.id, transcript);
    send('done', { transcript: saved });
  });
}));

app.post('/api/videos/download-audio/stream', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  sse(res, async (send) => {
    send('status', { message: 'Downloading video audio...' });
    const audioPath = await asr.downloadAudio(video, (message) => send('progress', { message }));
    send('done', { message: 'Audio download finished', audio_path: audioPath });
  });
}));

app.post('/api/transcripts/correct/stream', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const source = String(req.body.transcript || store.getTranscript(video.id)?.content || '');
  if (!source.trim()) throw new Error('没有可校正的字幕/转写文本');
  sse(res, async (send) => {
    send('status', { message: '正在 AI 校正文稿...' });
    const content = await ai.correctTranscript(video, source);
    const transcript = await store.saveTranscript(video.id, { source: 'ai_corrected', language: 'zh-CN', content });
    send('delta', { text: content });
    send('done', { transcript });
  });
}));

app.post('/api/summaries/stream', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const transcript = String(req.body.transcript || store.getTranscript(video.id)?.content || '');
  if (!transcript.trim()) throw new Error('没有可总结的字幕/转写文本');
  sse(res, async (send) => {
    send('status', { message: 'AI 正在生成学习笔记...' });
    const summary = await ai.summarize(video, transcript, String(req.body.instruction || ''));
    const saved = await store.saveSummary(video.id, { model: summary.model, markdown: summary.markdown });
    send('delta', { text: saved.markdown });
    send('done', { summary: saved });
  });
}));

app.post('/api/titles/short', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const result = await ai.shortTitle(video, String(req.body.text || ''), Number(req.body.index || 0));
  res.json(result);
}));

app.post('/api/notes', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const title = String(req.body.title || video.title);
  const markdown = String(req.body.markdown || '');
  if (!markdown.trim()) throw new Error('没有可保存的 Markdown');
  const note = await store.saveNote(video, title, markdown);
  res.json(note);
}));

app.post('/api/videos/save-workspace', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const transcriptText = String(req.body.transcript || '');
  const markdown = String(req.body.markdown || '');
  const out: { transcript?: Transcript; summary?: unknown; note?: Note } = {};
  if (transcriptText.trim()) {
    out.transcript = await store.saveTranscript(video.id, {
      source: 'manual_edit',
      language: 'zh-CN',
      content: transcriptText
    });
  }
  if (markdown.trim()) {
    out.summary = await store.saveSummary(video.id, {
      model: 'manual',
      markdown
    });
    out.note = await store.saveNote(video, String(req.body.title || video.title), markdown);
  }
  if (!out.transcript && !out.summary) throw new Error('nothing to save');
  res.json(out);
}));

app.post('/api/feishu/sync', asyncHandler(async (req, res) => {
  const note = store.getNote(String(req.body.note_id || ''));
  const documentId = await feishu.sync(note, {
    document_id: req.body.document_id,
    document_url: req.body.document_url,
    folder_token: req.body.folder_token,
    folder_url: req.body.folder_url
  });
  note.feishu_document_id = documentId;
  await store.updateNote(note);
  res.json(note);
}));

app.post('/api/screenshots', asyncHandler(async (req, res) => {
  const video = store.getVideo(String(req.body.video_id || ''));
  const dataUrl = String(req.body.image_data_url || '');
  const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error('截图不是有效 PNG data URL');
  const dir = path.join('notes', 'screenshots', video.id);
  await fs.mkdir(dir, { recursive: true });
  const id = randomUUID();
  const filePath = path.join(dir, `${id}.png`);
  await fs.writeFile(filePath, Buffer.from(match[1], 'base64'));
  res.json({ id, video_id: video.id, note_id: req.body.note_id || '', timestamp: Number(req.body.timestamp || 0), file_path: filePath, description: req.body.description || 'manual screenshot' });
}));

app.get('/api/courses', asyncHandler(async (_req, res) => {
  res.json({ courses: store.listCourses() });
}));

app.post('/api/courses/recover-asr-cache', asyncHandler(async (_req, res) => {
  const recovered = await recoverAsrCache();
  res.json({ recovered, courses: store.listCourses() });
}));

app.get('/api/courses/:id', asyncHandler(async (req, res) => {
  const course = store.getCourse(String(req.params.id));
  res.json({ course, lessons: store.listCourseLessons(course.id) });
}));

app.post('/api/courses/:id/refresh', asyncHandler(async (req, res) => {
  const course = store.getCourse(String(req.params.id));
  const added = await refreshCourseLessons(course.id);
  res.json({ course: store.getCourse(course.id), lessons: store.listCourseLessons(course.id), added });
}));

app.patch('/api/course-lessons/:id', asyncHandler(async (req, res) => {
  const lesson = await store.updateCourseLesson(String(req.params.id), {
    transcript: req.body.transcript,
    corrected_transcript: req.body.corrected_transcript,
    summary: req.body.summary,
    status: req.body.status,
    error: req.body.error
  });
  res.json(lesson);
}));

app.post('/api/course-lessons/:id', asyncHandler(async (req, res) => {
  const lesson = await store.updateCourseLesson(String(req.params.id), {
    transcript: req.body.transcript,
    corrected_transcript: req.body.corrected_transcript,
    summary: req.body.summary,
    status: req.body.status,
    error: req.body.error
  });
  res.json(lesson);
}));

app.post('/api/course-lessons/:id/transcribe', asyncHandler(async (req, res) => {
  let lesson = await ensureLessonVideo(store.getCourseLesson(String(req.params.id)));
  const body = isRecord(req.body) ? req.body : {};
  const language = normalizeASRLanguage(body.language) || cfg.asr.language || 'foreign';
  let audioPath = String(body.audio_path || lesson.audio_path || '').trim();
  if (!audioPath || !(await fileExists(audioPath))) {
    audioPath = await asr.downloadAudio(lesson.video!);
    lesson = await store.updateCourseLesson(lesson.id, { audio_path: audioPath, status: 'cached', error: '' });
  }
  await store.updateCourseLesson(lesson.id, { status: 'transcribing', error: '' });
  const transcript = await asr.transcribeAudio(lesson.video!, audioPath, undefined, { language });
  await store.saveTranscript(lesson.video!.id, transcript);
  const shouldCorrect = body.correct !== false;
  if (!shouldCorrect) {
    res.json(await store.updateCourseLesson(lesson.id, { transcript, status: 'correcting', error: '' }));
    return;
  }
  await store.updateCourseLesson(lesson.id, { transcript, status: 'correcting', error: '' });
  const correctedText = await ai.correctTranscript(lesson.video!, transcript.content);
  const corrected = await store.saveTranscript(lesson.video!.id, { source: 'ai_corrected', language: 'zh-CN', content: correctedText });
  res.json(await store.updateCourseLesson(lesson.id, { corrected_transcript: corrected, status: 'summarizing', error: '' }));
}));

app.post('/api/course-lessons/:id/download-audio/stream', asyncHandler(async (req, res) => {
  const initial = store.getCourseLesson(String(req.params.id));
  const body = isRecord(req.body) ? req.body : {};
  sse(res, async (send) => {
    let lesson = await ensureLessonVideo(initial, send);
    const currentAudio = String(body.audio_path || lesson.audio_path || '').trim();
    if (currentAudio && await fileExists(currentAudio)) {
      const updated = await store.updateCourseLesson(lesson.id, { audio_path: currentAudio, status: 'cached', error: '' });
      send('done', { lesson: updated, message: 'Audio is already cached' });
      return;
    }
    send('status', { message: 'Downloading lesson audio...' });
    await store.updateCourseLesson(lesson.id, { status: 'analyzing', error: '' });
    const audioPath = await asr.downloadAudio(lesson.video!, (message) => send('progress', { message }));
    lesson = await store.updateCourseLesson(lesson.id, {
      audio_path: audioPath,
      status: 'cached',
      error: 'Audio cached: ' + audioPath
    });
    send('done', { lesson, message: 'Audio download finished' });
  });
}));

app.post('/api/course-lessons/:id/transcribe/stream', asyncHandler(async (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const shouldCorrect = body.correct !== false;
  const language = normalizeASRLanguage(body.language) || cfg.asr.language || 'foreign';
  const initial = store.getCourseLesson(String(req.params.id));
  sse(res, async (send) => {
    let lesson = await ensureLessonVideo(initial, send);
    let audioPath = String(body.audio_path || lesson.audio_path || '').trim();
    if (!audioPath || !(await fileExists(audioPath))) {
      send('status', { message: 'No cached audio found, downloading first...' });
      audioPath = await asr.downloadAudio(lesson.video!, (message) => send('progress', { message }));
      lesson = await store.updateCourseLesson(lesson.id, { audio_path: audioPath, status: 'cached', error: '' });
    }
    send('status', { message: 'Starting lesson transcription...' });
    await store.updateCourseLesson(lesson.id, { status: 'transcribing', error: '' });
    const transcript = await asr.transcribeAudio(lesson.video!, audioPath, (message) => send('progress', { message }), { language });
    await store.saveTranscript(lesson.video!.id, transcript);
    send('progress', { message: 'ASR finished, transcript length: ' + transcript.content.length });
    if (!shouldCorrect) {
      const updated = await store.updateCourseLesson(lesson.id, { transcript, status: 'correcting', error: '' });
      send('done', { lesson: updated });
      return;
    }
    send('status', { message: 'Correcting transcript with AI...' });
    await store.updateCourseLesson(lesson.id, { transcript, status: 'correcting', error: '' });
    const correctedText = await ai.correctTranscript(lesson.video!, transcript.content);
    const corrected = await store.saveTranscript(lesson.video!.id, { source: 'ai_corrected', language: 'zh-CN', content: correctedText });
    send('progress', { message: 'AI correction finished, transcript length: ' + corrected.content.length });
    const updated = await store.updateCourseLesson(lesson.id, { corrected_transcript: corrected, status: 'summarizing', error: '' });
    send('done', { lesson: updated });
  });
}));

app.post('/api/course-lessons/:id/correct/stream', asyncHandler(async (req, res) => {
  const initial = store.getCourseLesson(String(req.params.id));
  sse(res, async (send) => {
    const lesson = await ensureLessonVideo(initial, send);
    const text = String(req.body.transcript || lesson.transcript?.content || lesson.corrected_transcript?.content || '');
    if (!text.trim()) throw new Error('lesson has no transcript to correct');
    send('status', { message: 'Correcting transcript with AI...' });
    await store.updateCourseLesson(lesson.id, { status: 'correcting', error: '' });
    const correctedText = await ai.correctTranscript(lesson.video!, text);
    const corrected = await store.saveTranscript(lesson.video!.id, { source: 'ai_corrected', language: 'zh-CN', content: correctedText });
    send('progress', { message: 'AI correction finished, transcript length: ' + corrected.content.length });
    const updated = await store.updateCourseLesson(lesson.id, { corrected_transcript: corrected, status: 'summarizing', error: '' });
    send('done', { lesson: updated, message: 'Transcript correction finished' });
  });
}));

app.post('/api/course-lessons/:id/summarize', asyncHandler(async (req, res) => {
  const lesson = await ensureLessonVideo(store.getCourseLesson(String(req.params.id)));
  const text = String(req.body.transcript || lesson.corrected_transcript?.content || lesson.transcript?.content || '');
  if (!text.trim()) throw new Error('lesson has no transcript to summarize');
  const updated = await store.updateCourseLesson(lesson.id, { status: 'summarizing', error: '' });
  const summary = await ai.summarize(lesson.video!, text, String(req.body.instruction || ''));
  const saved = await store.saveSummary(lesson.video!.id, { model: summary.model, markdown: summary.markdown });
  res.json(await store.updateCourseLesson(updated.id, { summary: saved, status: 'done' }));
}));

app.post('/api/course-lessons/:id/summarize/stream', asyncHandler(async (req, res) => {
  const initial = store.getCourseLesson(String(req.params.id));
  sse(res, async (send) => {
    const lesson = await ensureLessonVideo(initial, send);
    const text = String(req.body.transcript || lesson.corrected_transcript?.content || lesson.transcript?.content || '');
    if (!text.trim()) throw new Error('lesson has no transcript to summarize');
    send('status', { message: 'Starting summary, input length: ' + text.length });
    const updated = await store.updateCourseLesson(lesson.id, { status: 'summarizing', error: '' });
    send('status', { message: 'AI is generating study notes...' });
    const summary = await ai.summarize(lesson.video!, text, String(req.body.instruction || ''));
    send('progress', { message: 'AI summary finished, Markdown length: ' + summary.markdown.length });
    const saved = await store.saveSummary(lesson.video!.id, { model: summary.model, markdown: summary.markdown });
    const done = await store.updateCourseLesson(updated.id, { summary: saved, status: 'done' });
    send('done', { lesson: done });
  });
}));

app.post('/api/course-lessons/:id/run/stream', asyncHandler(async (req, res) => {
  const initial = store.getCourseLesson(String(req.params.id));
  const body = isRecord(req.body) ? req.body : {};
  const language = normalizeASRLanguage(body.language) || cfg.asr.language || 'foreign';
  sse(res, async (send) => {
    let lesson = await ensureLessonVideo(initial, send);
    let text = String(body.transcript || '').trim();
    if (text) {
      send('status', { message: 'Using edited transcript from the page...' });
      const manual = await store.saveTranscript(lesson.video!.id, { source: 'manual_edit', language: 'zh-CN', content: text });
      lesson = await store.updateCourseLesson(lesson.id, { corrected_transcript: manual, status: 'summarizing', error: '' });
    } else {
      text = lesson.corrected_transcript?.content || lesson.transcript?.content || '';
    }

    if (!text.trim()) {
      let audioPath = String(lesson.audio_path || '').trim();
      if (!audioPath || !(await fileExists(audioPath))) {
        send('status', { message: 'Downloading lesson audio...' });
        audioPath = await asr.downloadAudio(lesson.video!, (message) => send('progress', { message }));
        lesson = await store.updateCourseLesson(lesson.id, { audio_path: audioPath, status: 'cached', error: '' });
      }
      send('status', { message: 'Transcribing lesson audio...' });
      await store.updateCourseLesson(lesson.id, { status: 'transcribing', error: '' });
      const transcript = await asr.transcribeAudio(lesson.video!, audioPath, (message) => send('progress', { message }), { language });
      await store.saveTranscript(lesson.video!.id, transcript);
      lesson = await store.updateCourseLesson(lesson.id, { transcript, status: 'correcting', error: '' });
      text = transcript.content;
    }

    if (body.correct !== false && (!lesson.corrected_transcript || lesson.corrected_transcript.content !== text)) {
      send('status', { message: 'Correcting transcript with AI...' });
      await store.updateCourseLesson(lesson.id, { status: 'correcting', error: '' });
      text = await ai.correctTranscript(lesson.video!, text);
      const corrected = await store.saveTranscript(lesson.video!.id, { source: 'ai_corrected', language: 'zh-CN', content: text });
      lesson = await store.updateCourseLesson(lesson.id, { corrected_transcript: corrected, status: 'summarizing', error: '' });
    }

    if (!text.trim()) throw new Error('lesson has no transcript to summarize');
    send('status', { message: 'Generating summary, transcript length: ' + text.length });
    const summary = await ai.summarize(lesson.video!, text, String(body.instruction || ''));
    const saved = await store.saveSummary(lesson.video!.id, { model: summary.model, markdown: summary.markdown });
    lesson = await store.updateCourseLesson(lesson.id, { summary: saved, status: 'done', error: '' });
    send('done', { lesson, message: 'Single lesson run finished' });
  });
}));

app.post('/api/course-lessons/:id/note', asyncHandler(async (req, res) => {
  const lesson = store.getCourseLesson(String(req.params.id));
  if (!lesson.video) throw new Error('课时还没有解析视频信息');
  const markdown = String(req.body.markdown || lesson.summary?.markdown || '');
  if (!markdown.trim()) throw new Error('课时没有可保存的总结');
  const note = await store.saveNote(lesson.video, String(req.body.title || lesson.video.title), markdown);
  res.json(await store.attachLessonNote(lesson.id, note));
}));

app.post('/api/course-lessons/:id/feishu', asyncHandler(async (req, res) => {
  const lesson = store.getCourseLesson(String(req.params.id));
  if (!lesson.video) throw new Error('lesson has no video info');
  const markdown = String(req.body.markdown || lesson.summary?.markdown || lesson.note?.markdown || '');
  if (!markdown.trim()) throw new Error('lesson has no note markdown');
  const note = lesson.note || await store.saveNote(lesson.video, String(req.body.title || lesson.video.title), markdown);
  if (!lesson.note) await store.attachLessonNote(lesson.id, note);
  note.title = String(req.body.title || note.title || lesson.video.title);
  note.markdown = markdown;
  const documentId = await feishu.sync(note, {
    document_id: req.body.document_id,
    document_url: req.body.document_url,
    folder_token: req.body.folder_token,
    folder_url: req.body.folder_url
  });
  note.feishu_document_id = documentId;
  await store.updateNote(note);
  res.json(await store.attachLessonNote(lesson.id, note));
}));

app.post('/api/batch/album/stream', asyncHandler(async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) throw new Error('url is required');
  const limit = Math.max(0, Number(req.body.limit || 0));
  const workers = Math.min(8, Math.max(1, Number(req.body.workers || 2)));
  const target = String(req.body.target || '');
  const instruction = String(req.body.instruction || '');
  const transcribeMissing = Boolean(req.body.transcribe_missing);
  const skipCorrect = Boolean(req.body.skip_correct);
  const language = normalizeASRLanguage(req.body.language) || cfg.asr.language || 'foreign';

  sse(res, async (send) => {
    const urls = await expandVideoUrls(url, limit);
    send('log', { message: `[album] extracted ${urls.length} video(s), workers=${workers}` });
    urls.forEach((item, index) => send('log', { message: `[album] #${index + 1} ${item}` }));
    const course = await store.createCourse(url, `B站课程 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    for (const [index, item] of urls.entries()) {
      await store.upsertCourseLesson({ course_id: course.id, index: index + 1, url: item, status: 'queued' });
    }
    send('log', { message: `[course] saved ${course.id}` });
    const queue = urls.map((item, index) => ({ url: item, index: index + 1 }));
    await Promise.all(Array.from({ length: workers }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        await runBatchOne(item.url, item.index, urls.length, { courseId: course.id, instruction, target, transcribeMissing, skipCorrect, language }, send).catch(async (err) => {
          const lesson = store.listCourseLessons(course.id).find((entry) => entry.index === item.index);
          if (lesson) await store.updateCourseLesson(lesson.id, { status: 'error', error: (err as Error).message });
          send('log', { message: `[error] #${item.index} ${(err as Error).message}` });
        });
      }
    }));
    send('done', { message: '批量任务完成', report: 'notes' });
  });
}));

const staticDir = path.resolve('frontend/dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
}

app.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`B站视频总结工具: http://${cfg.server.host}:${cfg.server.port}`);
});

async function runBatchOne(
  url: string,
  index: number,
  total: number,
  options: { courseId?: string; instruction: string; target: string; transcribeMissing: boolean; skipCorrect: boolean; language: AppConfig['asr']['language'] },
  send: SendSSE
): Promise<void> {
  send('log', { message: `\n[${index}/${total}] ${url}` });
  const lesson = options.courseId ? store.listCourseLessons(options.courseId).find((item) => item.index === index) : undefined;
  if (lesson) await store.updateCourseLesson(lesson.id, { status: 'analyzing', error: '' });
  const { video, transcript } = await bilibili.analyze(url);
  await store.saveVideo(video);
  if (lesson) await store.updateCourseLesson(lesson.id, { video, transcript, status: transcript.content.trim() ? 'correcting' : 'transcribing' });
  send('log', { message: `[video] ${video.title} / ${video.bvid}` });
  let text = transcript.content;
  if (text.trim()) await store.saveTranscript(video.id, transcript);
  if (!text.trim() && options.transcribeMissing) {
    send('log', { message: '[transcribe] no public transcript, running ASR provider...' });
    if (lesson) await store.updateCourseLesson(lesson.id, { status: 'transcribing' });
    const asrText = await asr.transcribe(video, (message) => send('log', { message }), { language: options.language });
    text = asrText.content;
    await store.saveTranscript(video.id, asrText);
    if (lesson) await store.updateCourseLesson(lesson.id, { transcript: asrText, status: 'correcting' });
  }
  if (!text.trim()) throw new Error('没有字幕/转写文本，跳过');
  if (!options.skipCorrect) {
    send('log', { message: '[correct] correcting transcript...' });
    if (lesson) await store.updateCourseLesson(lesson.id, { status: 'correcting' });
    text = await ai.correctTranscript(video, text);
    const corrected = await store.saveTranscript(video.id, { source: 'ai_corrected', language: 'zh-CN', content: text });
    if (lesson) await store.updateCourseLesson(lesson.id, { corrected_transcript: corrected, status: 'summarizing' });
  }
  send('log', { message: '[summary] generating...' });
  if (lesson) await store.updateCourseLesson(lesson.id, { status: 'summarizing' });
  const summary = await ai.summarize(video, text, options.instruction);
  const title = await ai.shortTitle(video, summary.markdown, index);
  send('log', { message: `[title] ${title.title}` });
  const savedSummary = await store.saveSummary(video.id, { model: summary.model, markdown: summary.markdown });
  const note = await store.saveNote(video, title.title, summary.markdown);
  if (lesson) await store.updateCourseLesson(lesson.id, { summary: savedSummary, note, status: 'done', error: '' });
  send('log', { message: `[note] saved ${note.id}` });
  if (options.target.trim()) {
    const synced = await feishu.sync(note, options.target.includes('/folder/') ? { folder_url: options.target } : { document_url: options.target });
    note.feishu_document_id = synced;
    await store.updateNote(note);
    send('log', { message: `[feishu] ${synced}` });
  }
}

async function expandVideoUrls(url: string, limit: number): Promise<string[]> {
  const fromYtdlp = await ytdlpFlat(url).catch(() => []);
  const fromPages = extractBvid(url) ? await bilibili.listVideoPages(url).catch(() => []) : [];
  const ytdlpUrls = uniqueVideoUrls(fromYtdlp);
  const pageUrls = uniqueVideoUrls(fromPages);
  const urls = ytdlpUrls.length > 1 ? ytdlpUrls : pageUrls.length > 1 ? pageUrls : uniqueVideoUrls([url].filter((item) => extractBvid(item)));
  if (!urls.length) throw new Error('没有解析到 B站视频链接');
  return limit > 0 ? urls.slice(0, limit) : urls;
}

async function refreshCourseLessons(courseId: string): Promise<number> {
  const course = store.getCourse(courseId);
  const before = store.listCourseLessons(course.id).length;
  const pageInfos = extractBvid(course.source_url) ? await bilibili.listVideoPageInfos(course.source_url).catch(() => []) : [];
  if (pageInfos.length > 1) {
    for (const [index, video] of pageInfos.entries()) {
      await store.upsertCourseLesson({
        course_id: course.id,
        index: index + 1,
        url: video.url,
        video
      });
    }
  } else {
    const urls = await expandVideoUrls(course.source_url, 0);
    for (const [index, url] of urls.entries()) {
      await store.upsertCourseLesson({
        course_id: course.id,
        index: index + 1,
        url
      });
    }
  }
  return Math.max(0, store.listCourseLessons(course.id).length - before);
}

async function ytdlpFlat(url: string): Promise<string[]> {
  const raw = await runCapture('yt-dlp', ['--flat-playlist', '--dump-single-json', url]);
  const data = JSON.parse(raw) as { entries?: Array<{ webpage_url?: string; url?: string; id?: string }> };
  return (data.entries || [])
    .map((item) => item.webpage_url || item.url || item.id || '')
    .filter(Boolean)
    .map(normalizeBilibiliUrl)
    .filter(Boolean);
}

function uniqueVideoUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls.map(normalizeBilibiliUrl).filter(Boolean)) {
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

function normalizeBilibiliUrl(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^BV[0-9A-Za-z]{8,}/i.test(value)) return `https://www.bilibili.com/video/${value}`;
  const bvid = extractBvid(value);
  if (!bvid) return value;
  const page = (() => {
    try {
      const parsed = new URL(value.startsWith('http') ? value : `https://www.bilibili.com/video/${value}`);
      return parsed.searchParams.get('p') || parsed.searchParams.get('page') || '';
    } catch {
      return value.match(/[?&#](?:p|page)=(\d+)/i)?.[1] || '';
    }
  })();
  return `https://www.bilibili.com/video/${bvid}${Number(page) > 1 ? `?p=${Number(page)}` : ''}`;
}

function publicConfig() {
  return {
    ai: {
      provider: cfg.ai.provider,
      base_url: cfg.ai.base_url || '',
      model: cfg.ai.model || '',
      api_key_configured: Boolean(cfg.ai.api_key),
      spark_app_id_configured: Boolean(cfg.ai.spark_app_id),
      spark_api_key_configured: Boolean(cfg.ai.spark_api_key),
      spark_api_secret_configured: Boolean(cfg.ai.spark_api_secret),
      summary: publicAIProfile(cfg.ai.summary, cfg.ai),
      correction: publicAIProfile(cfg.ai.correction, cfg.ai),
      title: publicAIProfile(cfg.ai.title, cfg.ai)
    },
    asr: {
      provider: cfg.asr.provider,
      language: cfg.asr.language || 'foreign',
      model: cfg.asr.model || '',
      device: cfg.asr.device || 'auto',
      work_dir: cfg.asr.work_dir || '',
      local_engine: cfg.asr.local_engine || 'faster_whisper',
      local_profiles: cfg.asr.local_profiles || {},
      python_path: cfg.asr.python_path || '',
      openai_base_url: cfg.asr.provider === 'openai' ? cfg.asr.openai_base_url || '' : '',
      openai_api_key_configured: Boolean(cfg.asr.openai_api_key),
      spark_app_id_configured: Boolean(cfg.asr.spark_app_id),
      spark_api_key_configured: Boolean(cfg.asr.spark_api_key),
      spark_api_secret_configured: Boolean(cfg.asr.spark_api_secret)
    }
  };
}

function publicAIProfile(profile: AIServiceConfig | undefined, fallback: AppConfig['ai']) {
  const merged = mergeAIProfile(profile, fallback);
  return {
    provider: merged.provider,
    base_url: merged.base_url || '',
    model: merged.model || '',
    api_key_configured: Boolean(merged.api_key),
    spark_app_id_configured: Boolean(merged.spark_app_id),
    spark_api_key_configured: Boolean(merged.spark_api_key),
    spark_api_secret_configured: Boolean(merged.spark_api_secret)
  };
}

function mergeRuntimeConfig(current: AppConfig, body: Record<string, unknown>): AppConfig {
  const next: AppConfig = JSON.parse(JSON.stringify(current)) as AppConfig;
  const aiPatch = isRecord(body.ai) ? body.ai : {};
  const asrPatch = isRecord(body.asr) ? body.asr : {};

  const aiProvider = stringValue(aiPatch.provider);
  if (aiProvider && ['openai_compatible', 'deepseek', 'ollama', 'dify', 'spark'].includes(aiProvider)) {
    next.ai.provider = aiProvider as AppConfig['ai']['provider'];
  }
  assignString(next.ai, 'base_url', aiPatch.base_url);
  assignString(next.ai, 'model', aiPatch.model);
  assignSecret(next.ai, 'api_key', aiPatch.api_key);
  assignSecret(next.ai, 'spark_app_id', aiPatch.spark_app_id);
  assignSecret(next.ai, 'spark_api_key', aiPatch.spark_api_key);
  assignSecret(next.ai, 'spark_api_secret', aiPatch.spark_api_secret);
  next.ai.summary = mergeAIProfilePatch(next.ai.summary, next.ai, isRecord(aiPatch.summary) ? aiPatch.summary : undefined);
  next.ai.correction = mergeAIProfilePatch(next.ai.correction, next.ai, isRecord(aiPatch.correction) ? aiPatch.correction : undefined);
  next.ai.title = mergeAIProfilePatch(next.ai.title, next.ai, isRecord(aiPatch.title) ? aiPatch.title : undefined);

  const asrProvider = stringValue(asrPatch.provider);
  if (asrProvider && ['none', 'openai', 'local', 'spark'].includes(asrProvider)) {
    next.asr.provider = asrProvider as AppConfig['asr']['provider'];
  }
  const language = normalizeASRLanguage(asrPatch.language);
  if (language) next.asr.language = language;
  assignString(next.asr, 'model', asrPatch.model);
  const localEngine = stringValue(asrPatch.local_engine);
  if (localEngine && ['faster_whisper', 'funasr', 'sensevoice'].includes(localEngine)) {
    next.asr.local_engine = localEngine as AppConfig['asr']['local_engine'];
  }
  if (isRecord(asrPatch.local_profiles)) {
    next.asr.local_profiles = mergeLocalASRProfiles(next.asr.local_profiles, asrPatch.local_profiles);
  }
  assignString(next.asr, 'device', asrPatch.device);
  assignString(next.asr, 'work_dir', asrPatch.work_dir);
  assignString(next.asr, 'python_path', asrPatch.python_path);
  assignString(next.asr, 'openai_base_url', asrPatch.openai_base_url);
  assignSecret(next.asr, 'openai_api_key', asrPatch.openai_api_key);
  assignSecret(next.asr, 'spark_app_id', asrPatch.spark_app_id);
  assignSecret(next.asr, 'spark_api_key', asrPatch.spark_api_key);
  assignSecret(next.asr, 'spark_api_secret', asrPatch.spark_api_secret);
  return next;
}

function normalizeASRLanguage(value: unknown): AppConfig['asr']['language'] | undefined {
  const text = stringValue(value);
  if (text && ['zh', 'foreign', 'auto'].includes(text)) return text as AppConfig['asr']['language'];
  return undefined;
}

function mergeLocalASRProfiles(
  current: AppConfig['asr']['local_profiles'] | undefined,
  patch: Record<string, unknown>
): AppConfig['asr']['local_profiles'] {
  const next = { ...(current || {}) };
  for (const key of ['zh', 'foreign'] as const) {
    const raw = isRecord(patch[key]) ? patch[key] : undefined;
    if (!raw) continue;
    const profile = { ...(next[key] || {}) };
    const engine = stringValue(raw.engine);
    if (engine && ['faster_whisper', 'funasr', 'sensevoice'].includes(engine)) {
      profile.engine = engine as NonNullable<AppConfig['asr']['local_engine']>;
    }
    assignString(profile, 'model', raw.model);
    next[key] = profile;
  }
  return next;
}

function mergeAIProfile(profile: AIServiceConfig | undefined, fallback: AppConfig['ai']): AIServiceConfig {
  return {
    provider: profile?.provider || fallback.provider,
    base_url: profile?.base_url ?? fallback.base_url,
    api_key: profile?.api_key ?? fallback.api_key,
    api_key_env: profile?.api_key_env ?? fallback.api_key_env,
    model: profile?.model || fallback.model,
    spark_app_id: profile?.spark_app_id ?? fallback.spark_app_id,
    spark_app_id_env: profile?.spark_app_id_env ?? fallback.spark_app_id_env,
    spark_api_key: profile?.spark_api_key ?? fallback.spark_api_key,
    spark_api_key_env: profile?.spark_api_key_env ?? fallback.spark_api_key_env,
    spark_api_secret: profile?.spark_api_secret ?? fallback.spark_api_secret,
    spark_api_secret_env: profile?.spark_api_secret_env ?? fallback.spark_api_secret_env,
    dify_app_type: profile?.dify_app_type ?? fallback.dify_app_type,
    dify_user: profile?.dify_user ?? fallback.dify_user
  };
}

function mergeAIProfilePatch(current: AIServiceConfig | undefined, fallback: AppConfig['ai'], patch?: Record<string, unknown>): AIServiceConfig {
  const next = mergeAIProfile(current, fallback);
  if (!patch) return next;
  const provider = stringValue(patch.provider);
  if (provider && ['openai_compatible', 'deepseek', 'ollama', 'dify', 'spark'].includes(provider)) {
    next.provider = provider as AIServiceConfig['provider'];
  }
  assignString(next, 'base_url', patch.base_url);
  assignString(next, 'model', patch.model);
  assignSecret(next, 'api_key', patch.api_key);
  assignSecret(next, 'spark_app_id', patch.spark_app_id);
  assignSecret(next, 'spark_api_key', patch.spark_api_key);
  assignSecret(next, 'spark_api_secret', patch.spark_api_secret);
  assignString(next, 'dify_user', patch.dify_user);
  const difyAppType = stringValue(patch.dify_app_type);
  if (difyAppType === 'chat' || difyAppType === 'completion') next.dify_app_type = difyAppType;
  return next;
}

async function saveRuntimeConfig(next: AppConfig): Promise<void> {
  const target = path.resolve(configFile);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(next, null, 2), 'utf8');
}

function assignString<T extends Record<string, unknown>>(target: T, key: keyof T, value: unknown): void {
  const text = stringValue(value);
  if (text !== undefined) target[key] = text as T[keyof T];
}

function assignSecret<T extends Record<string, unknown>>(target: T, key: keyof T, value: unknown): void {
  const text = stringValue(value);
  if (text) target[key] = text as T[keyof T];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function ensureLessonVideo(lesson: CourseLesson, send?: SendSSE): Promise<CourseLesson> {
  if (lesson.video) {
    await store.saveVideo(lesson.video);
    return lesson;
  }
  send?.('status', { message: 'Resolving Bilibili lesson info...' });
  await store.updateCourseLesson(lesson.id, { status: 'analyzing', error: '' });
  const { video, transcript } = await bilibili.analyze(lesson.url);
  await store.saveVideo(video);
  const patch: Partial<CourseLesson> = { video, status: transcript.content.trim() ? 'correcting' : 'queued', error: '' };
  if (transcript.content.trim()) {
    patch.transcript = await store.saveTranscript(video.id, transcript);
  }
  return store.updateCourseLesson(lesson.id, patch);
}

async function fileExists(filePath: string): Promise<boolean> {
  if (!filePath.trim()) return false;
  const stat = await fs.stat(filePath).catch(() => undefined);
  return Boolean(stat?.isFile() && stat.size > 0);
}

async function recoverAsrCache(): Promise<number> {
  const workDir = cfg.asr.work_dir || 'notes/asr';
  const entries = await fs.readdir(workDir, { withFileTypes: true }).catch(() => []);
  const caches: Array<{ bvid: string; cid: number; audioPath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^(BV[0-9A-Za-z]{8,})-(\d+)$/i);
    if (!match) continue;
    const audioDir = path.join(workDir, entry.name, 'audio');
    const files = await fs.readdir(audioDir, { withFileTypes: true }).catch(() => []);
    const audioFiles: Array<{ path: string; size: number }> = [];
    for (const file of files) {
      if (!file.isFile() || file.name.endsWith('.part')) continue;
      const audioPath = path.join(audioDir, file.name);
      const stat = await fs.stat(audioPath).catch(() => undefined);
      if (stat && stat.size > 0) audioFiles.push({ path: audioPath, size: stat.size });
    }
    audioFiles.sort((a, b) => b.size - a.size);
    caches.push({ bvid: match[1], cid: Number(match[2]), audioPath: audioFiles[0]?.path || '' });
  }

  let recovered = 0;
  const byBvid = new Map<string, typeof caches>();
  for (const cache of caches) {
    const list = byBvid.get(cache.bvid) || [];
    list.push(cache);
    byBvid.set(cache.bvid, list);
  }

  for (const [bvid, items] of byBvid) {
    const sourceUrl = 'https://www.bilibili.com/video/' + bvid;
    const existing = store.listCourses().find((course) => course.source_url.includes(bvid));
    const course = existing || await store.createCourse(sourceUrl, 'ASR cache ' + bvid);
    const currentLessons = store.listCourseLessons(course.id);
    const videos = await bilibili.listVideoPageInfos(sourceUrl).catch(() => []);
    const cacheByCid = new Map(items.filter((item) => item.audioPath).map((item) => [item.cid, item.audioPath]));
    const lessonVideos = videos.length
      ? videos
      : [...items].sort((a, b) => a.cid - b.cid).map((cache, index) => ({
          id: randomUUID(),
          url: sourceUrl + (index > 0 ? '?p=' + (index + 1) : ''),
          bvid,
          cid: cache.cid,
          title: bvid + ' - ' + cache.cid,
          owner: '',
          cover_url: '',
          duration: 0
        }));

    for (const [zeroIndex, video] of lessonVideos.entries()) {
      const index = zeroIndex + 1;
      const current = currentLessons.find((item) => item.index === index);
      const audioPath = cacheByCid.get(video.cid) || current?.audio_path || '';
      const hasAudio = audioPath ? await fileExists(audioPath) : false;
      const keepStatus = current && !['queued', 'cached', 'analyzing', 'error'].includes(current.status);
      await store.upsertCourseLesson({
        course_id: course.id,
        index,
        url: video.url,
        video: current?.video || video,
        status: keepStatus ? current.status : hasAudio ? 'cached' : current?.status || 'queued',
        audio_path: audioPath,
        error: hasAudio ? 'Audio cached: ' + audioPath : current?.error || 'Audio not downloaded yet'
      });
      recovered += 1;
    }
  }
  return recovered;
}

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code}: ${stderr}`)));
  });
}

type SendSSE = (event: string, payload: unknown) => void;

function sse(res: express.Response, fn: (send: SendSSE) => Promise<void>): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const send: SendSSE = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  fn(send).catch((err) => send('error', { error: (err as Error).message })).finally(() => res.end());
}

function asyncHandler(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      if (res.headersSent) return;
      res.status(500).json({ error: (err as Error).message });
    });
  };
}
