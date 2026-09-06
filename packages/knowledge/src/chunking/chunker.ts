import type { ParsedDocument, ParsedSection } from '../parsers/types.js';

/**
 * Chunking (docs/architecture.md §5 Path A).
 *
 * Chunking decides retrieval quality more than almost anything else. Two
 * principles drive this implementation:
 *
 *   1. Never split mid-sentence when a sentence boundary is available. A
 *      fragment beginning "…and therefore the refund is void" is close to
 *      useless both to a retriever and to a reader.
 *   2. Every chunk carries its heading breadcrumb. A retrieved fragment must
 *      be intelligible on its own, because that is how the model and the
 *      citation UI will see it.
 */

export interface Chunk {
  readonly index: number;
  readonly content: string;
  readonly tokenCount: number;
  readonly page: number | null;
  readonly section: string | null;
  readonly headingPath: readonly string[];
}

export interface ChunkOptions {
  /** Target chunk size in tokens. */
  readonly targetTokens: number;
  /** Hard ceiling; a chunk is force-split rather than exceed this. */
  readonly maxTokens: number;
  /** Tokens of trailing context repeated at the start of the next chunk. */
  readonly overlapTokens: number;
  /** Chunks below this are merged into a neighbour rather than stored alone. */
  readonly minTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 512,
  maxTokens: 800,
  overlapTokens: 64,
  minTokens: 32,
};

/**
 * Token estimate.
 *
 * Deliberately an approximation, not a real tokenizer. Loading a BPE
 * vocabulary costs memory this host does not have (R1), and exact counts are
 * not needed here — the number is used for chunk sizing and display, never for
 * billing or for a hard provider limit. It is documented as an estimate
 * everywhere it surfaces.
 *
 * The ~4 characters per token ratio holds well for English prose; whitespace
 * count guards the degenerate case of long unbroken strings.
 */
export function estimateTokens(text: string): number {
  const characters = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(Math.max(characters / 4, words * 0.75)));
}

/** Split into sentences, keeping terminal punctuation and handling abbreviations. */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|no)\.\s/gi, '$1<DOT> ')
    .replace(/\b([A-Z])\.\s/g, '$1<DOT> ');

  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z"'([])|\n{2,}/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length > 0);
}

function headingLabel(headingPath: readonly string[]): string | null {
  const meaningful = headingPath.filter((h) => h.trim().length > 0);
  return meaningful.length > 0 ? (meaningful[meaningful.length - 1] ?? null) : null;
}

/**
 * Prefix a chunk with its breadcrumb so the stored text is self-describing.
 * This text is what gets embedded and what the model sees, so the context has
 * to be inside the chunk rather than alongside it.
 */
function withBreadcrumb(headingPath: readonly string[], body: string): string {
  const meaningful = headingPath.filter((h) => h.trim().length > 0);
  if (meaningful.length === 0) return body;
  return `${meaningful.join(' > ')}\n\n${body}`;
}

/** Take approximately `tokens` worth of trailing sentences, for overlap. */
function tailForOverlap(sentences: string[], tokens: number): string[] {
  const tail: string[] = [];
  let budget = tokens;
  for (let i = sentences.length - 1; i >= 0 && budget > 0; i -= 1) {
    const sentence = sentences[i]!;
    tail.unshift(sentence);
    budget -= estimateTokens(sentence);
  }
  return tail;
}

/**
 * Hard-split a single oversized sentence on whitespace.
 * Only reached by pathological input: minified data, a wall of text with no
 * punctuation, or a very long table row.
 */
function forceSplit(text: string, maxTokens: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    current.push(word);
    if (estimateTokens(current.join(' ')) >= maxTokens) {
      parts.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) parts.push(current.join(' '));
  return parts.length > 0 ? parts : [text];
}

function chunkSection(
  section: ParsedSection,
  options: ChunkOptions,
  emit: (content: string, tokens: number, page: number | null, path: readonly string[]) => void,
): void {
  const sentences = splitSentences(section.text);
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const body = buffer.join(' ').trim();
    if (body.length > 0) {
      const content = withBreadcrumb(section.headingPath, body);
      emit(content, estimateTokens(content), section.page, section.headingPath);
    }
    buffer = [];
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    // A single sentence larger than the ceiling cannot be packed; split it.
    if (sentenceTokens > options.maxTokens) {
      flush();
      for (const part of forceSplit(sentence, options.targetTokens)) {
        const content = withBreadcrumb(section.headingPath, part);
        emit(content, estimateTokens(content), section.page, section.headingPath);
      }
      continue;
    }

    const projected = estimateTokens([...buffer, sentence].join(' '));
    if (buffer.length > 0 && projected > options.targetTokens) {
      const overlap = options.overlapTokens > 0 ? tailForOverlap(buffer, options.overlapTokens) : [];
      flush();
      buffer = [...overlap];
    }

    buffer.push(sentence);
  }

  flush();
}

/**
 * Chunk a parsed document.
 *
 * Sections are chunked independently so a chunk never spans two headings —
 * merging content from different sections produces fragments that are
 * plausible-looking but attribute text to the wrong part of the document,
 * which is worse than returning nothing.
 */
export function chunkDocument(
  document: ParsedDocument,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of document.sections) {
    chunkSection(section, options, (content, tokenCount, page, headingPath) => {
      chunks.push({
        index: chunks.length,
        content,
        tokenCount,
        page,
        section: headingLabel(headingPath),
        headingPath: headingPath.filter((h) => h.trim().length > 0),
      });
    });
  }

  return mergeUndersized(chunks, options);
}

/** Compare two heading breadcrumbs element-wise. */
function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * Fold chunks below `minTokens` into the preceding chunk where they share a
 * heading path. A three-word chunk is noise in a retrieval index: it matches
 * on almost nothing and dilutes ranking.
 */
function mergeUndersized(chunks: Chunk[], options: ChunkOptions): Chunk[] {
  const merged: Chunk[] = [];

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    const sameSection =
      previous !== undefined &&
      samePath(previous.headingPath, chunk.headingPath) &&
      previous.page === chunk.page;

    if (
      previous !== undefined &&
      sameSection &&
      chunk.tokenCount < options.minTokens &&
      previous.tokenCount + chunk.tokenCount <= options.maxTokens
    ) {
      const content = `${previous.content}\n${chunk.content.replace(
        withBreadcrumb(chunk.headingPath, ''),
        '',
      )}`.trim();
      merged[merged.length - 1] = {
        ...previous,
        content,
        tokenCount: estimateTokens(content),
      };
      continue;
    }

    merged.push(chunk);
  }

  // Re-index so chunk_index is contiguous, which the unique index requires.
  return merged.map((chunk, index) => ({ ...chunk, index }));
}
