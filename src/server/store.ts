import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Note, Summary, Transcript, Video } from './types.js';

export class MemoryStore {
  videos = new Map<string, Video>();
  transcripts = new Map<string, Transcript>();
  summaries = new Map<string, Summary[]>();
  notes = new Map<string, Note>();
  notesByVideo = new Map<string, Note[]>();

  async saveVideo(video: Video): Promise<Video> {
    this.videos.set(video.id, video);
    return video;
  }

  getVideo(id: string): Video {
    const video = this.videos.get(id);
    if (!video) throw new Error('video not found');
    return video;
  }

  async saveTranscript(videoId: string, transcript: Transcript): Promise<Transcript> {
    const item = { ...transcript, id: transcript.id || randomUUID(), video_id: videoId };
    this.transcripts.set(videoId, item);
    return item;
  }

  getTranscript(videoId: string): Transcript | undefined {
    return this.transcripts.get(videoId);
  }

  async saveSummary(videoId: string, summary: Omit<Summary, 'id' | 'video_id'>): Promise<Summary> {
    const item: Summary = { id: randomUUID(), video_id: videoId, ...summary };
    const list = this.summaries.get(videoId) || [];
    list.unshift(item);
    this.summaries.set(videoId, list);
    return item;
  }

  async saveNote(video: Video, title: string, markdown: string, notesDir = 'notes'): Promise<Note> {
    const now = new Date().toISOString();
    const note: Note = {
      id: randomUUID(),
      video_id: video.id,
      title,
      markdown,
      feishu_document_id: '',
      created_at: now,
      updated_at: now
    };
    this.notes.set(note.id, note);
    const list = this.notesByVideo.get(video.id) || [];
    list.unshift(note);
    this.notesByVideo.set(video.id, list);
    await writeNoteFile(notesDir, video, note);
    return note;
  }

  getNote(id: string): Note {
    const note = this.notes.get(id);
    if (!note) throw new Error('note not found');
    return note;
  }

  async updateNote(note: Note): Promise<Note> {
    note.updated_at = new Date().toISOString();
    this.notes.set(note.id, note);
    return note;
  }
}

async function writeNoteFile(notesDir: string, video: Video, note: Note): Promise<void> {
  await fs.mkdir(notesDir, { recursive: true });
  const name = sanitizeFileName(`${video.bvid}_${note.title}`) + '.md';
  const body = [
    `# ${note.title}`,
    '',
    `- BVID: \`${video.bvid}\``,
    `- URL: ${video.url}`,
    `- UP: ${video.owner}`,
    '',
    note.markdown,
    ''
  ].join('\n');
  await fs.writeFile(path.join(notesDir, name), body, 'utf8');
}

function sanitizeFileName(value: string): string {
  const safe = value.replace(/[\\/:*?"<>|]/g, '_').trim();
  return Array.from(safe).slice(0, 80).join('') || randomUUID();
}

