import * as cheerio from 'cheerio';
// Type-only: erased at compile time, so these do NOT defeat the lazy
// `await import(...)` below. They exist purely to type the loaded module.
import type * as Unpdf from 'unpdf';
import type * as Mammoth from 'mammoth';
import {
  ParseError,
  type ParsedDocument,
  type ParsedSection,
  type Parser,
  type ParserInput,
} from './types.js';

/**
 * Parsers for binary and markup formats.
 *
 * PDF and DOCX libraries are loaded lazily. Both pull in substantial
 * dependency trees, and on a 7.3 GB host (docs/architecture.md R1) there is no
 * reason to hold them resident when a tenant only ever uploads Markdown.
 */

export const pdfParser: Parser = {
  name: 'pdf',
  mimeTypes: ['application/pdf'],
  extensions: ['.pdf'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    let unpdf: typeof Unpdf;
    try {
      unpdf = await import('unpdf');
    } catch {
      throw new ParseError('PDF support is unavailable in this deployment.', 'pdf');
    }

    try {
      const pdf = await unpdf.getDocumentProxy(new Uint8Array(input.bytes));
      // mergePages: false keeps page boundaries, which become citation anchors.
      const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: false });
      const pages: string[] = Array.isArray(text) ? text : [String(text)];

      const sections: ParsedSection[] = [];
      const emptyPages: number[] = [];

      pages.forEach((pageText, i) => {
        const cleaned = pageText.replace(/\s+\n/g, '\n').trim();
        if (cleaned.length === 0) {
          emptyPages.push(i + 1);
          return;
        }
        sections.push({ headingPath: [], text: cleaned, page: i + 1 });
      });

      const warnings: string[] = [];
      if (emptyPages.length > 0) {
        // Almost always a scanned PDF. Say so plainly rather than silently
        // ingesting an empty document that will never retrieve anything.
        warnings.push(
          `${emptyPages.length} of ${totalPages} page(s) contained no extractable text. ` +
            `If this is a scanned document, OCR is required (not yet implemented).`,
        );
      }

      return {
        title: null,
        sections,
        pageCount: totalPages,
        metadata: { pages: totalPages, emptyPages: emptyPages.length },
        warnings,
      };
    } catch (error) {
      if (error instanceof ParseError) throw error;
      throw new ParseError(
        `Could not read this PDF. It may be encrypted, corrupt, or password-protected.`,
        'pdf',
      );
    }
  },
};

export const docxParser: Parser = {
  name: 'docx',
  mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  extensions: ['.docx'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    let mammoth: typeof Mammoth;
    try {
      mammoth = await import('mammoth');
    } catch {
      throw new ParseError('DOCX support is unavailable in this deployment.', 'docx');
    }

    try {
      // Convert to HTML rather than raw text: HTML preserves the heading
      // structure that gives each chunk its breadcrumb.
      const result = await mammoth.convertToHtml({ buffer: Buffer.from(input.bytes) });
      const parsed = htmlToSections(result.value);

      return {
        title: parsed.title,
        sections: parsed.sections,
        pageCount: null,
        metadata: { messages: result.messages.length },
        warnings: result.messages.slice(0, 5).map((m) => String(m.message)),
      };
    } catch (error) {
      if (error instanceof ParseError) throw error;
      throw new ParseError('Could not read this Word document. It may be corrupt.', 'docx');
    }
  },
};

export const htmlParser: Parser = {
  name: 'html',
  mimeTypes: ['text/html', 'application/xhtml+xml'],
  extensions: ['.html', '.htm', '.xhtml'],
  async parse(input: ParserInput): Promise<ParsedDocument> {
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes);
    const parsed = htmlToSections(raw);
    return {
      title: parsed.title,
      sections: parsed.sections,
      pageCount: null,
      metadata: {},
      warnings: parsed.sections.length === 0 ? ['No readable text found in this HTML.'] : [],
    };
  },
};

/**
 * Convert HTML into heading-scoped sections.
 *
 * Script, style, nav, header, footer and aside elements are removed first.
 * Two reasons: they are boilerplate that pollutes retrieval, and script
 * content is attacker-controlled text that must never reach a prompt as if it
 * were document content (docs/security.md §4.1).
 */
export function htmlToSections(html: string): {
  title: string | null;
  sections: ParsedSection[];
} {
  const $ = cheerio.load(html);

  $('script, style, noscript, iframe, svg, nav, header, footer, aside, form').remove();
  $('[hidden], [aria-hidden="true"]').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || null;

  // A selector string rather than a node handle: cheerio types Cheerio<Element>
  // and Cheerio<Document> incompatibly, and `main`/`body` is all the scoping
  // that is needed. cheerio.load() always synthesises a body, so this is safe
  // for fragments as well as whole documents.
  const scope = $('main').length > 0 ? 'main' : 'body';

  const sections: ParsedSection[] = [];
  const headingStack: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > 0) {
      sections.push({ headingPath: [...headingStack], text, page: null });
    }
    buffer = [];
  };

  $(scope).find('h1, h2, h3, h4, h5, h6, p, li, td, th, pre, blockquote').each((_i, element) => {
    const node = $(element);
    const text = node.text().replace(/\s+/g, ' ').trim();
    if (text.length === 0) return;

    const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const headingLevel = /^h([1-6])$/.exec(tag);

    if (headingLevel) {
      flush();
      const depth = Number(headingLevel[1]);
      headingStack.length = Math.min(headingStack.length, depth - 1);
      for (let i = 0; i < depth - 1; i += 1) headingStack[i] ??= '';
      headingStack[depth - 1] = text;
      headingStack.length = depth;
      return;
    }

    buffer.push(text);
  });

  flush();
  return { title, sections };
}
