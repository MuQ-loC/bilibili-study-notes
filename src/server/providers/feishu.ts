import type { AppConfig, FeishuTarget, Note } from '../types.js';

export class FeishuProvider {
  constructor(private cfg: AppConfig['feishu']) {}

  async sync(note: Note, target: FeishuTarget = {}): Promise<string> {
    if (!this.cfg.enabled) throw new Error('飞书同步未启用');
    if (!this.cfg.app_id || !this.cfg.app_secret) throw new Error('飞书 app_id/app_secret 未配置');
    const token = await this.tenantToken();
    const normalized = normalizeTarget(target);
    const documentId =
      normalized.document_id ||
      this.cfg.document_id ||
      note.feishu_document_id ||
      (await this.createDocument(token, note.title, normalized.folder_token || this.cfg.folder_token || ''));
    await this.appendBlocks(token, documentId, markdownToBlocks(note.markdown));
    return documentId;
  }

  private async tenantToken(): Promise<string> {
    const res = await postJson<{ code: number; msg: string; tenant_access_token: string }>(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      '',
      { app_id: this.cfg.app_id, app_secret: this.cfg.app_secret }
    );
    if (res.code !== 0) throw new Error(`飞书 token 失败: ${res.code} ${res.msg}`);
    return res.tenant_access_token;
  }

  private async createDocument(token: string, title: string, folderToken: string): Promise<string> {
    const res = await postJson<{ code: number; msg: string; data: { document: { document_id: string } } }>(
      'https://open.feishu.cn/open-apis/docx/v1/documents',
      token,
      { title, ...(folderToken ? { folder_token: folderToken } : {}) }
    );
    if (res.code !== 0) throw new Error(`飞书创建文档失败: ${res.code} ${res.msg}`);
    return res.data.document.document_id;
  }

  private async appendBlocks(token: string, documentId: string, blocks: unknown[]): Promise<void> {
    const children = blocks.length ? blocks : [textBlock('暂无内容')];
    for (let i = 0; i < children.length; i += 40) {
      const res = await postJson<{ code: number; msg: string }>(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
        token,
        { children: children.slice(i, i + 40), index: -1 }
      );
      if (res.code !== 0) throw new Error(`飞书追加文档块失败: ${res.code} ${res.msg}`);
    }
  }
}

function normalizeTarget(target: FeishuTarget): FeishuTarget {
  return {
    ...target,
    document_id: target.document_id || tokenFromUrl(target.document_url || '', [/\/docx\/([^/?#]+)/, /\/docs\/([^/?#]+)/, /\/wiki\/([^/?#]+)/]),
    folder_token: target.folder_token || tokenFromUrl(target.folder_url || '', [/\/drive\/folder\/([^/?#]+)/, /\/folder\/([^/?#]+)/])
  };
}

function tokenFromUrl(value: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function markdownToBlocks(markdown: string): unknown[] {
  const blocks: unknown[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        if (codeLines.join('\n').trim()) blocks.push(codeBlock(codeLines.join('\n')));
        codeLines = [];
        inCode = false;
      } else inCode = true;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) continue;
    blocks.push(markdownLineToBlock(trimmed));
  }
  if (inCode && codeLines.join('\n').trim()) blocks.push(codeBlock(codeLines.join('\n')));
  return blocks;
}

function markdownLineToBlock(line: string): unknown {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return richTextBlock(2 + level, `heading${level}`, cleanInline(heading[2]));
  }
  const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
  if (bullet) return richTextBlock(12, 'bullet', cleanInline(bullet[1]));
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) return richTextBlock(13, 'ordered', cleanInline(ordered[1]));
  const quote = line.match(/^>\s+(.+)$/);
  if (quote) return richTextBlock(15, 'quote', cleanInline(quote[1]));
  return textBlock(cleanInline(line));
}

function cleanInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replaceAll('~~', '')
    .replaceAll('`', '')
    .trim();
}

function textBlock(text: string): unknown {
  return richTextBlock(2, 'text', text);
}

function codeBlock(text: string): unknown {
  return richTextBlock(14, 'code', text);
}

function richTextBlock(blockType: number, key: string, text: string): unknown {
  return {
    block_type: blockType,
    [key]: {
      elements: [{ text_run: { content: text } }],
      style: {}
    }
  };
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`飞书 HTTP ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

