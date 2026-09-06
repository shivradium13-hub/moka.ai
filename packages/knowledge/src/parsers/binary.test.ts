import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from './registry.js';

/**
 * PDF and DOCX parsing, against REAL files.
 *
 * The fixtures in `__fixtures__/` are genuine format-conformant files — a real
 * OOXML package and a real PDF with an uncompressed content stream — not text
 * with a misleading extension. Testing these parsers against fake bytes would
 * only prove the error path works.
 *
 * The PDF case additionally pins an environment property: `canvas`, pdfjs's
 * optional native dependency, is deliberately NOT built here (there is no MSVC
 * toolchain — docs/architecture.md R4). Text extraction must work without it.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

describe('pdf', () => {
  it('extracts text without the canvas native module', async () => {
    const bytes = new Uint8Array(await readFile(join(fixtures, 'sample.pdf')));
    const result = await parseDocument({
      bytes,
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
    });

    const text = result.sections.map((s) => s.text).join('\n');
    expect(text).toContain('Quarterly Report');
    expect(text).toContain('Revenue grew by 14 percent');
  });

  it('records the page number on each section, for citation anchors', async () => {
    const bytes = new Uint8Array(await readFile(join(fixtures, 'sample.pdf')));
    const result = await parseDocument({
      bytes,
      filename: 'sample.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.pageCount).toBe(1);
    expect(result.sections[0]?.page).toBe(1);
  });

  it('reports a corrupt PDF with a user-safe message', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('%PDF-1.4 this is not really a pdf'),
        filename: 'broken.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(/Could not read this PDF/);
  });
});

describe('docx', () => {
  it('extracts text from a real OOXML package', async () => {
    const bytes = new Uint8Array(await readFile(join(fixtures, 'sample.docx')));
    const result = await parseDocument({
      bytes,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const text = result.sections.map((s) => s.text).join('\n');
    expect(text).toContain('This handbook describes company policy.');
    expect(text).toContain('Refunds are issued within 30 days');
  });

  /*
   * DOCX is converted via HTML rather than to raw text specifically so that
   * Word heading styles survive as structure. If this breaks, chunks lose
   * their breadcrumbs and citations become far less useful.
   */
  it('preserves Word heading styles as breadcrumbs', async () => {
    const bytes = new Uint8Array(await readFile(join(fixtures, 'sample.docx')));
    const result = await parseDocument({
      bytes,
      filename: 'sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const refunds = result.sections.find((s) => s.text.includes('Refunds are issued'));
    expect(refunds?.headingPath).toEqual(['Employee Handbook', 'Refunds']);
  });

  it('reports a corrupt DOCX with a user-safe message', async () => {
    await expect(
      parseDocument({
        bytes: new TextEncoder().encode('PK not really a zip'),
        filename: 'broken.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).rejects.toThrow(/Could not read this Word document/);
  });
});
