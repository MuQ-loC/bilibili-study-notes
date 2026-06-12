import crypto from 'node:crypto';
import type { AppConfig, Transcript, Video } from '../types.js';

type ViewResponse = {
  code: number;
  message: string;
  data: {
    bvid: string;
    cid: number;
    title: string;
    pic: string;
    duration: number;
    owner: { mid: number; name: string };
    pages?: Array<{ cid: number; page: number; part: string; duration?: number }>;
  };
};

type PlayerResponse = {
  code: number;
  message: string;
  data: {
    subtitle: {
      subtitles: Array<{ lan: string; lan_doc: string; subtitle_url: string }>;
    };
  };
};

type SubtitleResponse = {
  body: Array<{ from: number; to: number; content: string }>;
};

type NavResponse = {
  code: number;
  data: { wbi_img: { img_url: string; sub_url: string } };
};

type ConclusionResponse = {
  code: number;
  message: string;
  data: {
    model_result: {
      summary?: string;
      subtitle?: Array<{ from: number; to: number; content: string }>;
      outline?: Array<{ title?: string; part_outline?: string; timestamp: number }>;
    };
  };
};

const WBI_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

export class BilibiliClient {
  private mixinKey = '';
  private mixinExpiresAt = 0;

  constructor(private cfg: AppConfig['bilibili']) {}

  async analyze(rawUrl: string): Promise<{ video: Video; transcript: Transcript }> {
    let bvid = extractBvid(rawUrl);
    if (!bvid && rawUrl) {
      const resolved = await this.resolveRedirect(rawUrl).catch(() => '');
      bvid = extractBvid(resolved);
    }
    if (!bvid) throw new Error('没有识别到 BVID');

    const requestedPage = extractPageNumber(rawUrl);
    const baseUrl = `https://www.bilibili.com/video/${bvid}`;
    const view = await this.fetchJson<ViewResponse>(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, baseUrl);
    if (view.code !== 0) throw new Error(`B站 view 接口失败: ${view.code} ${view.message}`);
    const pages = view.data.pages || [];
    const page = requestedPage > 0 ? pages.find((item) => item.page === requestedPage) : pages[0];
    const cid = page?.cid || view.data.cid || pages[0]?.cid || 0;
    const pageNo = page?.page || (requestedPage > 0 ? requestedPage : 1);
    const canonicalUrl = `${baseUrl}${pageNo > 1 ? `?p=${pageNo}` : ''}`;
    const pagePart = page?.part?.trim();
    const video: Video = {
      id: crypto.randomUUID(),
      url: canonicalUrl,
      bvid,
      cid,
      title: pagePart && pages.length > 1 ? `${view.data.title} - P${pageNo} ${pagePart}` : view.data.title,
      owner: view.data.owner?.name || '',
      cover_url: view.data.pic,
      duration: page?.duration || view.data.duration
    };

    const transcript: Transcript = { source: 'none', language: 'zh-CN', content: '' };
    if (cid > 0) {
      const subtitle = await this.fetchSubtitle(bvid, cid).catch(() => '');
      if (subtitle) return { video, transcript: { ...transcript, source: 'bilibili_cc', content: subtitle } };
      const conclusion = await this.fetchAIConclusion(bvid, cid, view.data.owner?.mid || 0).catch(() => '');
      if (conclusion) return { video, transcript: { ...transcript, source: 'bilibili_ai', content: conclusion } };
    }
    return { video, transcript };
  }

  async listVideoPages(rawUrl: string): Promise<string[]> {
    let bvid = extractBvid(rawUrl);
    if (!bvid && rawUrl) {
      const resolved = await this.resolveRedirect(rawUrl).catch(() => '');
      bvid = extractBvid(resolved);
    }
    if (!bvid) return [];
    const baseUrl = `https://www.bilibili.com/video/${bvid}`;
    const view = await this.fetchJson<ViewResponse>(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, baseUrl);
    if (view.code !== 0) return [];
    const pages = view.data.pages || [];
    if (pages.length <= 1) return [baseUrl];
    return pages
      .sort((a, b) => a.page - b.page)
      .map((page) => `${baseUrl}${page.page > 1 ? `?p=${page.page}` : ''}`);
  }

  private async resolveRedirect(rawUrl: string): Promise<string> {
    const res = await fetch(rawUrl, { headers: this.headers('https://www.bilibili.com/'), redirect: 'follow' });
    return res.url;
  }

  private async fetchSubtitle(bvid: string, cid: number): Promise<string> {
    const player = await this.fetchJson<PlayerResponse>(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
      `https://www.bilibili.com/video/${bvid}`
    );
    if (player.code !== 0) throw new Error(`B站 subtitle 接口失败: ${player.code} ${player.message}`);
    let subUrl = player.data.subtitle.subtitles[0]?.subtitle_url || '';
    if (!subUrl) throw new Error('该视频没有公开字幕');
    if (subUrl.startsWith('//')) subUrl = `https:${subUrl}`;
    const sub = await this.fetchJson<SubtitleResponse>(subUrl, `https://www.bilibili.com/video/${bvid}`);
    return formatSubtitle(sub.body || []);
  }

  private async fetchAIConclusion(bvid: string, cid: number, upMid: number): Promise<string> {
    if (!this.cfg.cookie?.trim()) throw new Error('未配置 BILIBILI_COOKIE');
    const params = new URLSearchParams({ bvid, cid: String(cid) });
    if (upMid > 0) params.set('up_mid', String(upMid));
    const signed = await this.signWbi(params);
    const out = await this.fetchJson<ConclusionResponse>(
      `https://api.bilibili.com/x/web-interface/view/conclusion/get?${signed}`,
      `https://www.bilibili.com/video/${bvid}`
    );
    if (out.code !== 0) throw new Error(`B站 AI 总结接口失败: ${out.code} ${out.message}`);
    return formatConclusion(out.data.model_result);
  }

  private async signWbi(params: URLSearchParams): Promise<string> {
    const key = await this.getMixinKey();
    params.set('wts', String(Math.floor(Date.now() / 1000)));
    const query = encodeWbi(params);
    params.set('w_rid', crypto.createHash('md5').update(query + key).digest('hex'));
    return encodeWbi(params);
  }

  private async getMixinKey(): Promise<string> {
    if (this.mixinKey && Date.now() < this.mixinExpiresAt) return this.mixinKey;
    const nav = await this.fetchJson<NavResponse>('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/');
    const raw = fileKey(nav.data.wbi_img.img_url) + fileKey(nav.data.wbi_img.sub_url);
    this.mixinKey = WBI_TABLE.map((idx) => raw[idx] || '').join('').slice(0, 32);
    this.mixinExpiresAt = Date.now() + 6 * 60 * 60 * 1000;
    return this.mixinKey;
  }

  private async fetchJson<T>(url: string, referer: string): Promise<T> {
    const res = await fetch(url, { headers: this.headers(referer) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  private headers(referer: string): HeadersInit {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      Referer: referer,
      Origin: 'https://www.bilibili.com',
      Accept: 'application/json, text/plain, */*'
    };
    if (this.cfg.cookie?.trim()) headers.Cookie = this.cfg.cookie.trim();
    return headers;
  }
}

export function extractBvid(value: string): string {
  return value.match(/(BV[0-9A-Za-z]{8,})/i)?.[1] || '';
}

export function extractPageNumber(value: string): number {
  if (!value) return 0;
  try {
    const parsed = new URL(value);
    const raw = parsed.searchParams.get('p') || parsed.searchParams.get('page') || '';
    const page = Number(raw);
    return Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
  } catch {
    const match = value.match(/[?&#](?:p|page)=(\d+)/i);
    return match ? Number(match[1]) : 0;
  }
}

function formatSubtitle(items: Array<{ from: number; to: number; content: string }>): string {
  return items
    .map((item) => `[${item.from.toFixed(1)}-${item.to.toFixed(1)}] ${item.content.trim()}`)
    .filter(Boolean)
    .join('\n');
}

function formatConclusion(result: ConclusionResponse['data']['model_result']): string {
  const parts: string[] = [];
  if (result.subtitle?.length) parts.push('# B站 AI 字幕\n\n' + formatSubtitle(result.subtitle));
  if (result.summary?.trim()) parts.push('# B站 AI 摘要\n\n' + result.summary.trim());
  if (result.outline?.length) {
    parts.push('# B站 AI 时间轴\n\n' + result.outline.map((item) => `- [${formatSeconds(item.timestamp)}] ${item.title || item.part_outline || ''}`).join('\n'));
  }
  return parts.join('\n\n').trim();
}

function formatSeconds(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function encodeWbi(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value.replace(/[!'()*]/g, ''))}`)
    .join('&');
}

function fileKey(rawUrl: string): string {
  const pathname = new URL(rawUrl).pathname;
  return pathname.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
}
