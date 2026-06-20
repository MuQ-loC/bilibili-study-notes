import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Course, CourseLesson, Note, Summary, Transcript, Video } from './types.js';

type LibraryData = {
  courses: Course[];
  lessons: CourseLesson[];
};

export class MemoryStore {
  videos = new Map<string, Video>();
  transcripts = new Map<string, Transcript>();
  summaries = new Map<string, Summary[]>();
  notes = new Map<string, Note>();
  notesByVideo = new Map<string, Note[]>();
  courses = new Map<string, Course>();
  lessons = new Map<string, CourseLesson>();
  lessonsByCourse = new Map<string, CourseLesson[]>();

  constructor(private libraryFile = path.join('notes', 'library.json')) {
    this.loadLibrary();
  }

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
    await this.persistLibrary();
    return note;
  }

  async createCourse(sourceUrl: string, title?: string): Promise<Course> {
    const now = new Date().toISOString();
    const course: Course = {
      id: randomUUID(),
      title: title || `B站课程 ${now.slice(0, 10)}`,
      source_url: sourceUrl,
      created_at: now,
      updated_at: now
    };
    this.courses.set(course.id, course);
    this.lessonsByCourse.set(course.id, []);
    await this.persistLibrary();
    return course;
  }

  listCourses(): Course[] {
    return [...this.courses.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  getCourse(id: string): Course {
    const course = this.courses.get(id);
    if (!course) throw new Error('course not found');
    return course;
  }

  listCourseLessons(courseId: string): CourseLesson[] {
    return [...(this.lessonsByCourse.get(courseId) || [])].sort((a, b) => a.index - b.index);
  }

  async upsertCourseLesson(input: Partial<CourseLesson> & { course_id: string; index: number; url: string }): Promise<CourseLesson> {
    const current = input.id ? this.lessons.get(input.id) : this.findLesson(input.course_id, input.index);
    const now = new Date().toISOString();
    const lesson: CourseLesson = {
      id: current?.id || randomUUID(),
      course_id: input.course_id,
      index: input.index,
      url: input.url,
      status: input.status || current?.status || 'queued',
      error: input.error ?? current?.error ?? '',
      audio_path: input.audio_path ?? current?.audio_path ?? '',
      video: input.video ?? current?.video,
      transcript: input.transcript ?? current?.transcript,
      corrected_transcript: input.corrected_transcript ?? current?.corrected_transcript,
      summary: input.summary ?? current?.summary,
      note: input.note ?? current?.note,
      created_at: current?.created_at || now,
      updated_at: now
    };
    this.lessons.set(lesson.id, lesson);
    const list = this.lessonsByCourse.get(lesson.course_id) || [];
    const index = list.findIndex((item) => item.id === lesson.id);
    if (index >= 0) list[index] = lesson;
    else list.push(lesson);
    this.lessonsByCourse.set(lesson.course_id, list);
    this.touchCourse(lesson.course_id);
    this.hydrateLesson(lesson);
    await this.persistLibrary();
    return lesson;
  }

  getCourseLesson(id: string): CourseLesson {
    const lesson = this.lessons.get(id);
    if (!lesson) throw new Error('lesson not found');
    return lesson;
  }

  async updateCourseLesson(id: string, patch: Partial<CourseLesson>): Promise<CourseLesson> {
    const lesson = this.getCourseLesson(id);
    return this.upsertCourseLesson({ ...lesson, ...patch, id: lesson.id, course_id: lesson.course_id, index: lesson.index, url: lesson.url });
  }

  async attachLessonNote(lessonId: string, note: Note): Promise<CourseLesson> {
    return this.updateCourseLesson(lessonId, { note });
  }

  private findLesson(courseId: string, index: number): CourseLesson | undefined {
    return (this.lessonsByCourse.get(courseId) || []).find((item) => item.index === index);
  }

  private touchCourse(courseId: string): void {
    const course = this.courses.get(courseId);
    if (course) {
      course.updated_at = new Date().toISOString();
      this.courses.set(courseId, course);
    }
  }

  private loadLibrary(): void {
    if (!fsSync.existsSync(this.libraryFile)) return;
    try {
      const data = JSON.parse(fsSync.readFileSync(this.libraryFile, 'utf8')) as LibraryData;
      for (const course of data.courses || []) {
        this.courses.set(course.id, course);
        this.lessonsByCourse.set(course.id, []);
      }
      for (const lesson of data.lessons || []) {
        this.lessons.set(lesson.id, lesson);
        const list = this.lessonsByCourse.get(lesson.course_id) || [];
        list.push(lesson);
        this.lessonsByCourse.set(lesson.course_id, list);
        this.hydrateLesson(lesson);
      }
    } catch {
      // Ignore broken library files; the next write will recreate it.
    }
  }

  private hydrateLesson(lesson: CourseLesson): void {
    if (lesson.video) this.videos.set(lesson.video.id, lesson.video);
    const videoId = lesson.video?.id;
    if (videoId && lesson.corrected_transcript) this.transcripts.set(videoId, lesson.corrected_transcript);
    else if (videoId && lesson.transcript) this.transcripts.set(videoId, lesson.transcript);
    if (videoId && lesson.summary) this.summaries.set(videoId, [lesson.summary]);
    if (videoId && lesson.note) {
      this.notes.set(lesson.note.id, lesson.note);
      const list = this.notesByVideo.get(videoId) || [];
      if (!list.some((item) => item.id === lesson.note?.id)) list.unshift(lesson.note);
      this.notesByVideo.set(videoId, list);
    }
  }

  private async persistLibrary(): Promise<void> {
    const dir = path.dirname(this.libraryFile);
    await fs.mkdir(dir, { recursive: true });
    const data: LibraryData = {
      courses: this.listCourses(),
      lessons: [...this.lessons.values()].sort((a, b) => a.course_id.localeCompare(b.course_id) || a.index - b.index)
    };
    await fs.writeFile(this.libraryFile, JSON.stringify(data, null, 2), 'utf8');
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
