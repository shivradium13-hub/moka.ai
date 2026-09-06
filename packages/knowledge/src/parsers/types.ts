import { z } from 'zod';

/**
 * Document parsing contract (docs/architecture.md §5 Path A).
 *
 * A parser turns raw bytes into normalised text plus structure. It must be
 * PURE with respect to the outside world: no network access, no filesystem
 * access, no shelling out. Parsers run over untrusted, user-supplied files,
 * so the smaller their blast radius the better.
 */

export interface ParsedSection {
  /** Heading breadcrumb enclosing this text, outermost first. */
  readonly headingPath: readonly string[];
  readonly text: string;
  /** 1-based page number where known (PDFs); null otherwise. */
  readonly page: number | null;
}

export interface ParsedDocument {
  readonly title: string | null;
  readonly sections: readonly ParsedSection[];
  readonly pageCount: number | null;
  /** Parser-specific detail, e.g. sheet names or row counts. */
  readonly metadata: Record<string, unknown>;
  /**
   * Non-fatal problems encountered while parsing — an unreadable page, a
   * malformed row. Surfaced to the user rather than silently dropped, so a
   * partially-ingested document is visibly partial.
   */
  readonly warnings: readonly string[];
}

export interface Parser {
  readonly name: string;
  /** MIME types this parser claims. */
  readonly mimeTypes: readonly string[];
  /** Lowercase extensions including the dot, used when MIME type is unreliable. */
  readonly extensions: readonly string[];
  parse(input: ParserInput): Promise<ParsedDocument>;
}

export interface ParserInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
}

export const parsedDocumentSchema = z.object({
  title: z.string().nullable(),
  sections: z.array(
    z.object({
      headingPath: z.array(z.string()),
      text: z.string(),
      page: z.number().int().positive().nullable(),
    }),
  ),
  pageCount: z.number().int().positive().nullable(),
  metadata: z.record(z.unknown()),
  warnings: z.array(z.string()),
});

/** Raised when a file cannot be parsed. Message is safe to show a user. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly parser: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}
