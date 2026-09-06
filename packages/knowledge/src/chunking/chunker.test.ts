import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_OPTIONS,
  chunkDocument,
  estimateTokens,
  splitSentences,
  type ChunkOptions,
} from './chunker.js';
import type { ParsedDocument, ParsedSection } from '../parsers/types.js';

function doc(sections: ParsedSection[]): ParsedDocument {
  return { title: null, sections, pageCount: null, metadata: {}, warnings: [] };
}

function section(text: string, headingPath: string[] = [], page: number | null = null): ParsedSection {
  return { headingPath, text, page };
}

const sentence = (n: number): string =>
  `This is sentence number ${n} and it contains enough words to carry some weight.`;

describe('estimateTokens', () => {
  it('scales with length', () => {
    expect(estimateTokens('hello')).toBeGreaterThan(0);
    expect(estimateTokens(sentence(1).repeat(10))).toBeGreaterThan(estimateTokens(sentence(1)));
  });

  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });

  // A long unbroken string has few words but many characters; the character
  // term must dominate so it is not wildly under-counted.
  it('does not under-count long unbroken strings', () => {
    expect(estimateTokens('x'.repeat(400))).toBeGreaterThan(50);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('One. Two! Three?')).toHaveLength(3);
  });

  it('does not split on common abbreviations', () => {
    const result = splitSentences('Dr. Smith met Mrs. Jones at 5pm. Then they left.');
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('Dr. Smith');
    expect(result[0]).toContain('Mrs. Jones');
  });

  it('restores protected dots', () => {
    expect(splitSentences('See e.g. this case. Done.').join(' ')).toContain('e.g.');
  });

  it('splits on blank lines', () => {
    expect(splitSentences('Para one\n\nPara two')).toHaveLength(2);
  });
});

describe('chunkDocument', () => {
  it('returns nothing for an empty document', () => {
    expect(chunkDocument(doc([]))).toEqual([]);
  });

  it('keeps a short section as a single chunk', () => {
    const chunks = chunkDocument(doc([section('A short policy statement.')]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain('A short policy statement.');
  });

  it('assigns contiguous indexes starting at zero', () => {
    const long = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkDocument(doc([section(long)]));
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
  });

  /*
   * The breadcrumb must be INSIDE the chunk text: that text is what gets
   * embedded and what the model sees, so context stored alongside it would be
   * lost at exactly the moment it matters.
   */
  it('prefixes each chunk with its heading breadcrumb', () => {
    const chunks = chunkDocument(
      doc([section('Refunds are issued within 30 days.', ['Handbook', 'Policies', 'Refunds'])]),
    );
    expect(chunks[0]?.content).toContain('Handbook > Policies > Refunds');
    expect(chunks[0]?.content).toContain('Refunds are issued');
  });

  it('records the section label and heading path', () => {
    const chunks = chunkDocument(doc([section('Body.', ['A', 'B'])]));
    expect(chunks[0]?.section).toBe('B');
    expect(chunks[0]?.headingPath).toEqual(['A', 'B']);
  });

  it('drops empty heading levels from the breadcrumb', () => {
    const chunks = chunkDocument(doc([section('Body.', ['A', '', 'C'])]));
    expect(chunks[0]?.headingPath).toEqual(['A', 'C']);
  });

  /*
   * Merging across headings produces fragments that attribute text to the
   * wrong part of a document — worse than returning nothing.
   */
  it('never merges content across different headings', () => {
    const chunks = chunkDocument(
      doc([section('Alpha content.', ['One']), section('Beta content.', ['Two'])]),
    );
    const alpha = chunks.find((c) => c.content.includes('Alpha'));
    expect(alpha?.content).not.toContain('Beta');
  });

  it('carries the page number through, for citations', () => {
    const chunks = chunkDocument(doc([section('Page text.', [], 7)]));
    expect(chunks[0]?.page).toBe(7);
  });

  it('respects the token ceiling', () => {
    const long = Array.from({ length: 200 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkDocument(doc([section(long)]));
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
    }
  });

  it('overlaps consecutive chunks so context is not severed at the boundary', () => {
    const sentences = Array.from({ length: 60 }, (_, i) => sentence(i));
    const chunks = chunkDocument(doc([section(sentences.join(' '))]));
    expect(chunks.length).toBeGreaterThan(1);

    const first = chunks[0]!.content;
    const second = chunks[1]!.content;
    const tail = first.trim().split(/(?<=\.)\s+/).slice(-1)[0]!;
    expect(second).toContain(tail.slice(0, 30));
  });

  it('can be configured with no overlap', () => {
    const options: ChunkOptions = { ...DEFAULT_CHUNK_OPTIONS, overlapTokens: 0 };
    const sentences = Array.from({ length: 60 }, (_, i) => sentence(i));
    const chunks = chunkDocument(doc([section(sentences.join(' '))]), options);

    const first = chunks[0]!.content;
    const tail = first.trim().split(/(?<=\.)\s+/).slice(-1)[0]!;
    expect(chunks[1]!.content).not.toContain(tail.slice(0, 30));
  });

  // Minified JSON, a wall of text, or a very long table row.
  it('force-splits a single sentence longer than the ceiling', () => {
    const monster = 'word '.repeat(4000);
    const chunks = chunkDocument(doc([section(monster)]));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens);
    }
  });

  it('never emits a blank chunk', () => {
    const chunks = chunkDocument(doc([section('   \n\n   '), section('Real content.')]));
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  // A three-word chunk matches almost nothing and dilutes ranking.
  it('folds an undersized fragment into its neighbour', () => {
    const chunks = chunkDocument(
      doc([section(`${sentence(1)} ${sentence(2)}\n\nOk.`, ['H'])]),
      { ...DEFAULT_CHUNK_OPTIONS, minTokens: 20 },
    );
    expect(chunks.every((c) => c.tokenCount >= 10)).toBe(true);
  });
});
