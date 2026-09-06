import { ParseError, type ParsedDocument, type Parser, type ParserInput } from './types.js';
import { csvParser, jsonParser, markdownParser, plainTextParser } from './text.js';
import { docxParser, htmlParser, pdfParser } from './binary.js';

/**
 * Parser registry (§11, §12).
 *
 * The extensibility promise: adding a format means adding a Parser and
 * registering it here. Nothing in the ingestion pipeline, chunker, retriever
 * or API dispatches on file type, so none of them change.
 */

export const PARSERS: readonly Parser[] = [
  plainTextParser,
  markdownParser,
  jsonParser,
  csvParser,
  htmlParser,
  pdfParser,
  docxParser,
];

/** Largest file accepted for ingestion. Enforced before any parser runs. */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/**
 * Choose a parser.
 *
 * Extension is preferred over the declared MIME type: browsers report
 * `application/octet-stream` for many uploads, and a client-supplied
 * content-type is untrusted input in any case. Neither is treated as
 * authoritative — the parser itself fails if the bytes do not match.
 */
export function selectParser(filename: string, mimeType: string): Parser | null {
  const extension = extensionOf(filename);
  const normalisedMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';

  if (extension) {
    const byExtension = PARSERS.find((p) => p.extensions.includes(extension));
    if (byExtension) return byExtension;
  }
  return PARSERS.find((p) => p.mimeTypes.includes(normalisedMime)) ?? null;
}

export function supportedExtensions(): string[] {
  return [...new Set(PARSERS.flatMap((p) => p.extensions))].sort();
}

/**
 * Parse a document, enforcing the size cap and normalising failures.
 *
 * Any error from a parser is converted into a ParseError with a user-safe
 * message: parser internals can echo file content, and an ingestion failure
 * must not become a way to read back arbitrary bytes through an error string.
 */
export async function parseDocument(input: ParserInput): Promise<ParsedDocument> {
  if (input.bytes.byteLength === 0) {
    throw new ParseError('File is empty.', 'registry');
  }
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new ParseError(
      `File exceeds the ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB limit.`,
      'registry',
    );
  }

  const parser = selectParser(input.filename, input.mimeType);
  if (!parser) {
    throw new ParseError(
      `Unsupported file type. Supported: ${supportedExtensions().join(', ')}`,
      'registry',
    );
  }

  try {
    return await parser.parse(input);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError(`Could not read this ${parser.name} file.`, parser.name);
  }
}
