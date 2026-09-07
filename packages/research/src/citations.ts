/**
 * The citation ledger (master prompt §9, §45; architecture §5 Path C).
 *
 * THE GATE THIS PHASE IS MEASURED ON: no fabricated citations.
 *
 * The failure mode is specific and well documented. Ask a model to research
 * something and cite its sources, and it will produce a bibliography — plausible
 * titles, plausible authors, URLs that resolve to nothing or to something else
 * entirely. It is not lying; it is completing a pattern. And a fabricated
 * citation is worse than no citation, because it converts an unsupported claim
 * into an apparently sourced one, which is exactly the form people stop
 * checking.
 *
 * SO THE MODEL IS NEVER GIVEN THE CHANCE.
 *
 * It does not write URLs. It writes `[3]`. Every URL in the finished answer
 * comes from the LEDGER — a record of documents this system actually fetched,
 * with the final URL after redirects, the time, and a hash of what came back.
 * A citation is a lookup, not a generation.
 *
 * Two checks then run over the model's output, after the fact, in the same
 * spirit as Phase 6's grounding check:
 *
 *   1. Every `[n]` must resolve to a real ledger entry. Markers that do not
 *      are removed and reported — a model that invents a fourth source when it
 *      was given three has produced an unsupported sentence, and the reader
 *      must not see a citation marker beside it.
 *
 *   2. Any absolute URL appearing in the answer must appear VERBATIM in the
 *      evidence the model was shown. A model quoting a link out of a fetched
 *      page is fine. A model producing one from its training data is the exact
 *      failure this file exists to prevent, and it is removed.
 *
 * None of this makes the prose true. It makes every source attached to it real,
 * which is a smaller claim and an honest one.
 */

export interface Evidence {
  /** 1-based. The only handle the model is given for a source. */
  readonly id: number;
  /** The URL that was finally fetched, AFTER redirects. */
  readonly url: string;
  /** What was originally requested. Differs from `url` on redirect. */
  readonly requestedUrl: string;
  readonly title: string | null;
  readonly fetchedAt: Date;
  /** SHA-256 of the retrieved bytes, so a source can be shown to be unchanged. */
  readonly contentHash: string;
  /** Exactly the text that was placed in the prompt. Nothing else was shown. */
  readonly excerpt: string;
}

export interface Citation {
  readonly id: number;
  readonly url: string;
  readonly title: string | null;
  readonly fetchedAt: Date;
  readonly contentHash: string;
  /**
   * Whether a quoted span attributed to this source was found in it.
   *
   * `null` means the answer quoted nothing from this source, which is the
   * common case and is not a problem — most citations support a paraphrase.
   */
  readonly quoteVerified: boolean | null;
}

export interface VerifiedAnswer {
  /** The answer with unsupported markers and invented URLs removed. */
  readonly text: string;
  /** Sources actually cited, in order of first appearance. */
  readonly citations: readonly Citation[];
  /** Marker numbers the model used that name no real source. */
  readonly invalidMarkers: readonly number[];
  /** URLs the model produced that appear in no fetched document. */
  readonly inventedUrls: readonly string[];
  /** Quoted spans attributed to a source but absent from it. */
  readonly unverifiedQuotes: readonly string[];
  /**
   * True when the answer made claims with no valid citation at all.
   *
   * Reported rather than suppressed: an uncited research answer is sometimes
   * legitimate ("I could not find anything on this"), and the caller decides.
   */
  readonly unsupported: boolean;
}

/** Absolute http(s) URLs. Deliberately not matching bare domains. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/gi;

/** `[3]`, `[3, 5]` and `[3][5]` are all in the wild. */
const MARKER_PATTERN = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Double-quoted spans long enough to be a real quotation rather than a term. */
const QUOTE_PATTERN = /[“"]([^”"]{25,400})[”"]/g;

/**
 * Build the ledger from documents that were actually fetched.
 *
 * Ids are assigned HERE, in fetch order, and are the only way to refer to a
 * source anywhere downstream. There is no path by which a model-supplied
 * string becomes a citation.
 */
export function buildLedger(
  documents: ReadonlyArray<Omit<Evidence, 'id'>>,
): Map<number, Evidence> {
  const ledger = new Map<number, Evidence>();
  documents.forEach((document, index) => {
    const id = index + 1;
    ledger.set(id, { ...document, id });
  });
  return ledger;
}

/**
 * Render the evidence a model is allowed to see.
 *
 * NOTE WHAT IS ABSENT: the full URL. The model is shown the title and the
 * HOST, which is what it needs to weigh credibility — "the vendor's own
 * documentation" versus "a forum post" — and not enough to reconstruct a
 * citable link. Giving it the URL would put the exact string we are trying to
 * keep it from producing directly into its context.
 *
 * Excerpts are neutralised by the caller before they get here; this function
 * only lays them out.
 */
export function renderEvidence(ledger: ReadonlyMap<number, Evidence>): string {
  return [...ledger.values()]
    .map((entry) => {
      const host = safeHost(entry.url);
      const heading = `[${entry.id}] ${entry.title ?? 'Untitled'}${host ? ` — ${host}` : ''}`;
      return `${heading}\n${entry.excerpt}`;
    })
    .join('\n\n');
}

/**
 * Check a model's answer against the ledger.
 *
 * Runs AFTER the model has spoken, on what it actually said — not on what it
 * was asked to do. An instruction to cite only real sources is a nudge; this
 * is the control.
 */
export function verifyAnswer(
  rawAnswer: string,
  ledger: ReadonlyMap<number, Evidence>,
): VerifiedAnswer {
  const invalidMarkers = new Set<number>();
  const usedOrder: number[] = [];

  /*
   * Pass 1 — citation markers.
   *
   * A marker naming a source that does not exist is removed rather than left
   * in place. Leaving it would show the reader a citation for a claim that has
   * none, which is the precise deception being guarded against.
   */
  let text = rawAnswer.replace(MARKER_PATTERN, (match, group: string) => {
    const numbers = group.split(',').map((part) => Number.parseInt(part.trim(), 10));
    const valid = numbers.filter((n) => ledger.has(n));
    const invalid = numbers.filter((n) => !ledger.has(n));

    for (const n of invalid) invalidMarkers.add(n);
    for (const n of valid) {
      if (!usedOrder.includes(n)) usedOrder.push(n);
    }

    if (valid.length === 0) return '';
    if (valid.length === numbers.length) return match;
    return `[${valid.join(', ')}]`;
  });

  /*
   * Pass 2 — URLs.
   *
   * The evidence corpus is the union of every excerpt shown. A URL the model
   * produced that appears in none of them was not read anywhere; it was
   * recalled or invented. Removed, and reported so a caller can log it — an
   * invented URL is a signal worth counting over time.
   */
  const corpus = [...ledger.values()].map((entry) => entry.excerpt).join('\n');
  const inventedUrls: string[] = [];

  text = text.replace(URL_PATTERN, (match) => {
    // Trailing punctuation belongs to the sentence, not the URL.
    const trimmed = match.replace(/[.,;:!?)\]]+$/, '');
    const trailing = match.slice(trimmed.length);
    if (corpus.includes(trimmed)) return match;
    inventedUrls.push(trimmed);
    return `[link removed]${trailing}`;
  });

  /*
   * Pass 3 — quotations.
   *
   * A quoted span attributed to a source should be findable in it. This is a
   * SIGNAL rather than an edit: models paraphrase inside quotation marks often
   * enough that deleting on a miss would mangle honest answers. So an
   * unverified quote is reported and the citation is marked, and a human or a
   * caller decides what that is worth.
   */
  const unverifiedQuotes: string[] = [];
  const quoteResults = new Map<number, boolean>();

  for (const match of rawAnswer.matchAll(QUOTE_PATTERN)) {
    const quote = match[1]!;
    // Attribute the quote to the nearest following marker, which is where a
    // citation conventionally sits.
    const after = rawAnswer.slice(match.index + match[0].length, match.index + match[0].length + 40);
    const marker = /\[(\d+)\]/.exec(after);
    const target = marker ? Number.parseInt(marker[1]!, 10) : null;

    const candidates =
      target !== null && ledger.has(target)
        ? [ledger.get(target)!]
        : [...ledger.values()];

    const found = candidates.some((entry) => containsQuote(entry.excerpt, quote));
    if (target !== null && ledger.has(target)) {
      quoteResults.set(target, (quoteResults.get(target) ?? true) && found);
    }
    if (!found) unverifiedQuotes.push(quote);
  }

  const citations: Citation[] = usedOrder.map((id) => {
    const entry = ledger.get(id)!;
    return {
      id: entry.id,
      url: entry.url,
      title: entry.title,
      fetchedAt: entry.fetchedAt,
      contentHash: entry.contentHash,
      quoteVerified: quoteResults.has(id) ? quoteResults.get(id)! : null,
    };
  });

  return {
    text: tidy(text),
    citations,
    invalidMarkers: [...invalidMarkers].sort((a, b) => a - b),
    inventedUrls,
    unverifiedQuotes,
    unsupported: citations.length === 0,
  };
}

/**
 * Whether a quotation appears in a source.
 *
 * Compared on collapsed whitespace and normalised quotation marks, because
 * extraction reflows text and a curly apostrophe is not a different quotation.
 * Anything beyond that — stemming, fuzzy matching — would start accepting
 * paraphrase as quotation, which is the thing being checked.
 */
export function containsQuote(source: string, quote: string): boolean {
  return normaliseForQuote(source).includes(normaliseForQuote(quote));
}

function normaliseForQuote(value: string): string {
  return value
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Collapse the whitespace left behind by removed markers. */
function tidy(text: string): string {
  return text
    .replace(/ {2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * The standing instruction attached to every research synthesis.
 *
 * Like every prompt-level rule in this codebase: it measurably helps and it is
 * not the control. `verifyAnswer` is the control, and it runs whether or not
 * the model read this.
 */
export const CITATION_INSTRUCTIONS = [
  'Answer only from the numbered sources below. Cite every factual claim with',
  'its source number in square brackets, like [2]. A sentence with no source',
  'number will be read as unsupported.',
  '',
  'Never write a URL. Never cite a number that is not listed below. If the',
  'sources do not answer the question, say so plainly and explain what is',
  'missing — that is a useful answer, and inventing one is not.',
].join('\n');
