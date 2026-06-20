import type { AppConfig, FeishuTarget, Note } from '../types.js';

type FeishuBlock = Record<string, unknown>;
type TablePlan = { kind: 'table'; rows: string[][] };
type RenderItem = FeishuBlock | TablePlan;

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

  private async appendBlocks(token: string, documentId: string, blocks: RenderItem[]): Promise<void> {
    const items = blocks.length ? blocks : [textBlock('暂无内容')];
    let pending: FeishuBlock[] = [];

    const flushPending = async () => {
      if (!pending.length) return;
      for (let i = 0; i < pending.length; i += 40) {
        const res = await postJson<{ code: number; msg: string }>(
          `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
          token,
          { children: pending.slice(i, i + 40), index: -1 }
        );
        if (res.code !== 0) throw new Error(`飞书追加文档块失败: ${res.code} ${res.msg}`);
      }
      pending = [];
    };

    for (const item of items) {
      if (isTablePlan(item)) {
        await flushPending();
        await this.appendTable(token, documentId, item.rows);
      } else {
        pending.push(item);
      }
    }
    await flushPending();
  }

  private async appendTable(token: string, documentId: string, rows: string[][]): Promise<void> {
    const cleanRows = normalizeTableRows(rows);
    if (!cleanRows.length) return;
    const columnSize = Math.max(...cleanRows.map((row) => row.length), 1);
    const normalizedRows = cleanRows.map((row) => [...row, ...Array(columnSize - row.length).fill('')]);
    const tableRes = await postJson<{
      code: number;
      msg: string;
      data?: { children?: Array<{ block_id?: string; children?: string[] }> };
    }>(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      token,
      {
        children: [
          {
            block_type: 31,
            table: {
              property: {
                row_size: normalizedRows.length,
                column_size: columnSize
              }
            }
          }
        ],
        index: -1
      }
    );
    if (tableRes.code !== 0) throw new Error(`飞书创建表格失败: ${tableRes.code} ${tableRes.msg}`);
    const cellIds = tableRes.data?.children?.[0]?.children || [];
    if (cellIds.length < normalizedRows.length * columnSize) {
      throw new Error('飞书创建表格成功，但没有返回完整单元格 ID');
    }
    for (let rowIndex = 0; rowIndex < normalizedRows.length; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < columnSize; columnIndex += 1) {
        const text = cleanInline(normalizedRows[rowIndex][columnIndex] || '');
        if (!text) continue;
        const cellId = cellIds[rowIndex * columnSize + columnIndex];
        const res = await postJson<{ code: number; msg: string }>(
          `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${cellId}/children`,
          token,
          { children: [textBlock(text)], index: -1 }
        );
        if (res.code !== 0) throw new Error(`飞书写入表格单元格失败: ${res.code} ${res.msg}`);
      }
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

function markdownToBlocks(markdown: string): RenderItem[] {
  const blocks: RenderItem[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        if (codeLines.join('\n').trim()) blocks.push(codeBlock(codeLines.join('\n')));
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed || trimmed === '---') continue;

    const table = readMarkdownTable(lines, i);
    if (table) {
      blocks.push({ kind: 'table', rows: table.rows });
      i = table.endIndex;
      continue;
    }

    blocks.push(markdownLineToBlock(trimmed));
  }
  if (inCode && codeLines.join('\n').trim()) blocks.push(codeBlock(codeLines.join('\n')));
  return blocks;
}

function readMarkdownTable(lines: string[], startIndex: number): { rows: string[][]; endIndex: number } | undefined {
  const first = lines[startIndex]?.trim();
  const second = lines[startIndex + 1]?.trim();
  if (!isTableRow(first) || !isTableSeparator(second)) return undefined;
  const rows: string[][] = [splitTableRow(first)];
  let endIndex = startIndex + 1;
  for (let i = startIndex + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!isTableRow(line)) break;
    rows.push(splitTableRow(line));
    endIndex = i;
  }
  return { rows, endIndex };
}

function isTableRow(value = ''): boolean {
  return value.includes('|') && splitTableRow(value).length >= 2;
}

function isTableSeparator(value = ''): boolean {
  const cells = splitTableRow(value);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(value: string): string[] {
  const trimmed = value.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function markdownLineToBlock(line: string): FeishuBlock {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    const level = heading[1].length;
    return richTextBlock(2 + level, `heading${level}`, cleanInline(heading[2]));
  }
  const numberedHeading = line.match(/^(\d+(?:\.\d+)*)\s+(.+)$/);
  if (numberedHeading) {
    const level = numberedHeading[1].includes('.') ? 3 : 2;
    return richTextBlock(level + 2, `heading${level}`, cleanInline(`${numberedHeading[1]} ${numberedHeading[2]}`));
  }
  const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
  if (bullet) return richTextBlock(12, 'bullet', cleanInline(bullet[1]));
  const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
  if (ordered) return richTextBlock(13, 'ordered', cleanInline(ordered[1]));
  const quote = line.match(/^>\s+(.+)$/);
  if (quote) return richTextBlock(15, 'quote', cleanInline(quote[1]));
  return textBlock(cleanInline(line));
}

function normalizeTableRows(rows: string[][]): string[][] {
  return rows
    .map((row) => row.map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean));
}

function isTablePlan(value: RenderItem): value is TablePlan {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'table';
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

function textBlock(text: string): FeishuBlock {
  return richTextBlock(2, 'text', text);
}

function codeBlock(text: string): FeishuBlock {
  return richTextBlock(14, 'code', text);
}

function richTextBlock(blockType: number, key: string, text: string): FeishuBlock {
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
