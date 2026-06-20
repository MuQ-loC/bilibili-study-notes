import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { MemoryStore } from './store.js';
import type { CourseLesson, Note, Transcript, Video } from './types.js';
import { AIProvider } from './providers/ai.js';
import { ASRProvider } from './providers/asr.js';
import { BilibiliClient, extractBvid } from './providers/bilibili.js';
import { FeishuProvider } from './providers/feishu.js';
import { TTSProvider } from './providers/tts.js';

const cfg = loadConfig(process.env.CONFIG_PATH || 'config.json');
const app = express();
const store = new MemoryStore();
const bilibili = new BilibiliClient(cfg.bilibili);
const ai = new AIProvider(cfg.ai);
const asr = new ASRProvider(cfg.asr);
const feishu = new FeishuProvider(cfg.feishu);
const tts = new TTSProvider(cfg.tts);

app.use(express.json({ limit: '30mb' }));
app.use('/files', express.static('notes'));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
  sse(res, async (send) => {
    const transcript = await asr.transcribe(video, (message) => send('progress', { message }));
    const saved = await store.saveTranscript(video.id, transcript);
    send('done', { transcript: saved });
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
  let audioPath = String(req.body.audio_path || lesson.audio_path || '').trim();
  if (!audioPath || !(await fileExists(audioPath))) {
    audioPath = await asr.downloadAudio(lesson.video!);
    lesson = await store.updateCourseLesson(lesson.id, { audio_path: audioPath, status: 'cached', error: '' });
  }
  await store.updateCourseLesson(lesson.id, { status: 'transcribing', error: '' });
  const transcript = await asr.transcribeAudio(lesson.video!, audioPath);
  await store.saveTranscript(lesson.video!.id, transcript);
  const shouldCorrect = req.body.correct !== false;
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
  sse(res, async (send) => {
    let lesson = await ensureLessonVideo(initial, send);
    const currentAudio = String(req.body.audio_path || lesson.audio_path || '').trim();
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
  const shouldCorrect = req.body.correct !== false;
  const initial = store.getCourseLesson(String(req.params.id));
  sse(res, async (send) => {
    let lesson = await ensureLessonVideo(initial, send);
    let audioPath = String(req.body.audio_path || lesson.audio_path || '').trim();
    if (!audioPath || !(await fileExists(audioPath))) {
      send('status', { message: 'No cached audio found, downloading first...' });
      audioPath = await asr.downloadAudio(lesson.video!, (message) => send('progress', { message }));
      lesson = await store.updateCourseLesson(lesson.id, { audio_path: audioPath, status: 'cached', error: '' });
    }
    send('status', { message: 'Starting lesson transcription...' });
    await store.updateCourseLesson(lesson.id, { status: 'transcribing', error: '' });
    const transcript = await asr.transcribeAudio(lesson.video!, audioPath, (message) => send('progress', { message }));
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
  sse(res, async (send) => {
    let lesson = await ensureLessonVideo(initial, send);
    let text = String(req.body.transcript || '').trim();
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
      const transcript = await asr.transcribeAudio(lesson.video!, audioPath, (message) => send('progress', { message }));
      await store.saveTranscript(lesson.video!.id, transcript);
      lesson = await store.updateCourseLesson(lesson.id, { transcript, status: 'correcting', error: '' });
      text = transcript.content;
    }

    if (req.body.correct !== false && (!lesson.corrected_transcript || lesson.corrected_transcript.content !== text)) {
      send('status', { message: 'Correcting transcript with AI...' });
      await store.updateCourseLesson(lesson.id, { status: 'correcting', error: '' });
      text = await ai.correctTranscript(lesson.video!, text);
      const corrected = await store.saveTranscript(lesson.video!.id, { source: 'ai_corrected', language: 'zh-CN', content: text });
      lesson = await store.updateCourseLesson(lesson.id, { corrected_transcript: corrected, status: 'summarizing', error: '' });
    }

    if (!text.trim()) throw new Error('lesson has no transcript to summarize');
    send('status', { message: 'Generating summary, transcript length: ' + text.length });
    const summary = await ai.summarize(lesson.video!, text, String(req.body.instruction || ''));
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
        await runBatchOne(item.url, item.index, urls.length, { courseId: course.id, instruction, target, transcribeMissing, skipCorrect }, send).catch(async (err) => {
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
  options: { courseId?: string; instruction: string; target: string; transcribeMissing: boolean; skipCorrect: boolean },
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
    const asrText = await asr.transcribe(video, (message) => send('log', { message }));
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
