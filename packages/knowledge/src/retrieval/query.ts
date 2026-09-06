/**
 * Query construction for PostgreSQL full-text search.
 *
 * User input reaches `to_tsquery` here, so it must be sanitised. Rather than
 * escaping the tsquery operator language — which is easy to get subtly wrong —
 * the query is rebuilt from extracted terms, so no user-supplied character is
 * ever interpreted as an operator. (The value is still passed as a bind
 * parameter; this is defence in depth, not the only protection.)
 */

/** Longest query accepted. Beyond this, FTS planning cost outweighs any benefit. */
export const MAX_QUERY_LENGTH = 500;
const MAX_TERMS = 24;

/**
 * Very common words carry no retrieval signal but do cost planning time.
 * PostgreSQL's english dictionary strips most of these itself; this trims the
 * term list before it reaches the database.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
  'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
  'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with',
]);

export interface ParsedQuery {
  /** Safe `tsquery` string, or null when nothing usable remains. */
  readonly tsquery: string | null;
  /** Extracted terms, for trigram fallback and highlighting. */
  readonly terms: readonly string[];
  /** Phrases the user quoted, matched adjacently. */
  readonly phrases: readonly string[];
}

/**
 * Extract terms and quoted phrases, discarding everything else.
 *
 * Note this is allowlisting, not escaping: only letters, digits, hyphen and
 * apostrophe survive. `&`, `|`, `!`, `:`, `*` and parentheses — the entire
 * tsquery operator set — cannot pass through by construction.
 */
export function parseQuery(input: string): ParsedQuery {
  const trimmed = input.slice(0, MAX_QUERY_LENGTH);

  const phrases: string[] = [];
  const withoutPhrases = trimmed.replace(/"([^"]{1,120})"/g, (_match, phrase: string) => {
    const words = extractWords(phrase);
    if (words.length > 0) phrases.push(words.join(' '));
    return ' ';
  });

  const terms = extractWords(withoutPhrases)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .slice(0, MAX_TERMS);

  const clauses: string[] = [];

  // Adjacent match for quoted phrases.
  for (const phrase of phrases.slice(0, 4)) {
    const words = phrase.split(' ');
    if (words.length > 0) clauses.push(words.join(' <-> '));
  }

  // Remaining terms are OR-ed: a document matching three of five terms should
  // still rank, and ranking (not filtering) decides the final order.
  if (terms.length > 0) clauses.push(terms.join(' | '));

  return {
    tsquery: clauses.length > 0 ? clauses.join(' & ') : null,
    terms,
    phrases,
  };
}

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((word) => word.replace(/^[-']+|[-']+$/g, ''))
    .filter((word) => word.length > 0);
}

/** Trigram fallback string, used when a query yields no usable tsquery terms. */
export function trigramNeedle(input: string): string {
  return input.slice(0, MAX_QUERY_LENGTH).trim();
}
