import Papa from 'papaparse';
import { ParseError, type ParsedSection, type Parser, type ParserInput, type ParsedDocument } from './types.js';

/**
 * Parsers for text-shaped formats. All pure JavaScript — no native modules
 * (this machine has no MSVC toolchain) and no network access.
 */

function decodeUtf8(bytes: Uint8Array): string {
  // `fatal: false` so a stray invalid byte yields U+FFFD rather than throwing
  // and losing an otherwise-readable document.
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // A leading U+FEFF is a byte-order mark, not content. Left in place it
  // becomes part of the first Markdown heading or CSV header name.
  return decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
}

/** Split plain text into sections on blank lines, preserving order. */
function paragraphs(text: string): ParsedSection[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => ({ headingPath: [] as readonly string[], text: block, page: null }));
}

export const plainTextParser: Parser = {
  name: 'text',
  mimeTypes: ['text/plain'],
  extensions: ['.txt', '.log', '.text'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    const text = decodeUtf8(input.bytes);
    return {
      title: null,
      sections: paragraphs(text),
      pageCount: null,
      metadata: { characters: text.length },
      warnings: [],
    };
  },
};

/**
 * Markdown parser.
 *
 * Tracks the heading hierarchy so each chunk carries the breadcrumb it sits
 * under. That breadcrumb is what makes a retrieved fragment intelligible in a
 * citation — "Refund window" alone is far less useful than
 * "Policies › Returns › Refund window".
 */
export const markdownParser: Parser = {
  name: 'markdown',
  mimeTypes: ['text/markdown', 'text/x-markdown'],
  extensions: ['.md', '.markdown', '.mdx'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    const text = decodeUtf8(input.bytes);
    const lines = text.split(/\r?\n/);

    const sections: ParsedSection[] = [];
    const headingStack: string[] = [];
    let buffer: string[] = [];
    let title: string | null = null;
    let inFence = false;

    const flush = (): void => {
      const body = buffer.join('\n').trim();
      if (body.length > 0) {
        sections.push({ headingPath: [...headingStack], text: body, page: null });
      }
      buffer = [];
    };

    for (const line of lines) {
      // Fenced code blocks may contain '#' at line start; those are not headings.
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        buffer.push(line);
        continue;
      }

      const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        const depth = heading[1]!.length;
        const label = heading[2]!.trim();
        headingStack.length = Math.min(headingStack.length, depth - 1);
        headingStack[depth - 1] = label;
        // Fill any skipped levels so the breadcrumb has no holes.
        for (let i = 0; i < depth; i += 1) headingStack[i] ??= '';
        headingStack.length = depth;
        title ??= depth === 1 ? label : null;
        continue;
      }

      buffer.push(line);
    }
    flush();

    return {
      title,
      sections,
      pageCount: null,
      metadata: { headings: sections.filter((s) => s.headingPath.length > 0).length },
      warnings: inFence ? ['Unterminated code fence; content may be mis-segmented.'] : [],
    };
  },
};

export const jsonParser: Parser = {
  name: 'json',
  mimeTypes: ['application/json'],
  extensions: ['.json'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    const raw = decodeUtf8(input.bytes);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new ParseError(
        `File is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
        'json',
      );
    }

    /*
     * Flatten to `path: value` lines. A pretty-printed JSON blob chunks badly —
     * splitting it mid-object produces fragments that retrieve poorly and read
     * as noise. One line per leaf keeps each fragment self-describing.
     */
    const lines: string[] = [];
    const walk = (node: unknown, path: string, depth: number): void => {
      if (depth > 12) return;
      if (node === null || typeof node !== 'object') {
        lines.push(`${path || 'value'}: ${String(node)}`);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
        return;
      }
      for (const [key, item] of Object.entries(node)) {
        walk(item, path ? `${path}.${key}` : key, depth + 1);
      }
    };
    walk(value, '', 0);

    return {
      title: null,
      sections: lines.length > 0 ? [{ headingPath: [], text: lines.join('\n'), page: null }] : [],
      pageCount: null,
      metadata: { leaves: lines.length },
      warnings: [],
    };
  },
};

/**
 * CSV / TSV parser.
 *
 * Each row becomes one section rendered as `Header: value` pairs. Rendering
 * rows with their headers rather than as bare comma-separated values matters:
 * a retrieved row must carry its own column meaning, since the header row is
 * almost never in the same chunk.
 */
export const csvParser: Parser = {
  name: 'csv',
  mimeTypes: ['text/csv', 'text/tab-separated-values', 'application/csv'],
  extensions: ['.csv', '.tsv'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    const raw = decodeUtf8(input.bytes);
    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
    });

    const warnings = result.errors
      .slice(0, 10)
      .map((e) => `Row ${e.row ?? '?'}: ${e.message}`);

    const rows = Array.isArray(result.data) ? result.data : [];
    const sections: ParsedSection[] = rows
      .map((row) => {
        const text = Object.entries(row)
          .filter(([, v]) => v != null && String(v).trim() !== '')
          .map(([k, v]) => `${k}: ${String(v).trim()}`)
          .join('\n');
        return { headingPath: [] as readonly string[], text, page: null };
      })
      .filter((s) => s.text.length > 0);

    if (result.errors.length > 10) {
      warnings.push(`…and ${result.errors.length - 10} further row problems.`);
    }

    return {
      title: null,
      sections,
      pageCount: null,
      metadata: { rows: sections.length, columns: result.meta.fields?.length ?? 0 },
      warnings,
    };
  },
};
