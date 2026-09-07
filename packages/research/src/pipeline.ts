import {
  CITATION_INSTRUCTIONS,
  buildLedger,
  renderEvidence,
  verifyAnswer,
  type Citation,
  type Evidence,
  type VerifiedAnswer,
} from './citations.js';
import { excerptFor, extractPage } from './extract.js';
import { normaliseUrl } from './crawl.js';
import type { SearchHit, SearchProvider } from './search.js';

/**
 * The Path C research pipeline (architecture §5, master prompt §8, §9).
 *
 *   question → search → collect → extract → verify → synthesize → cite
 *
 * Written as a pure orchestrator over injected collaborators — a fetcher, a
 * robots checker, a model — so the whole sequence can be driven in a test with
 * no network and no provider. Everything interesting here is a decision about
 * what to do when a step fails, and those are exactly the paths that never get
 * exercised if the test needs the internet.
 *
 * THE RULE THIS PIPELINE EXISTS TO ENFORCE
 *
 * A source is a document we fetched. Not a URL a model produced, not a title
 * it remembered, not a snippet a search engine returned. Search results are
 * used only to decide what to fetch; if a fetch fails, that candidate is gone,
 * and it cannot be cited.
 *
 * The sharpest expression of that is `NO_SOURCES`: when nothing was collected,
 * the model is NOT CALLED AT ALL. Asking a model to answer with citations
 * while giving it nothing to cite is asking it to invent a bibliography, and
 * it will oblige. Refusing costs a provider call and saves a fabrication.
 */

export interface FetchedPage {
  readonly status: number;
  /** After redirects. This is what gets cited. */
  readonly finalUrl: string;
  readonly contentType: string | null;
  readonly body: string;
  readonly byteLength: number;
  readonly contentHash: string;
}

export interface PageFetcher {
  /**
   * Fetch one page.
   *
   * Throwing is the normal way to report a refusal — an SSRF block, a
   * timeout, an oversized response. The pipeline records the reason and
   * carries on with the remaining candidates.
   */
  fetch(url: string): Promise<FetchedPage>;
}

export interface RobotsChecker {
  /** Whether this URL may be fetched, per the site's own robots.txt. */
  allowed(url: string): Promise<boolean>;
}

export interface ResearchModel {
  synthesize(request: {
    system: string;
    user: string;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

export const SourceOutcome = {
  COLLECTED: 'collected',
  ROBOTS_DISALLOWED: 'robots_disallowed',
  FETCH_FAILED: 'fetch_failed',
  BLOCKED: 'blocked',
  NOT_HTML: 'not_html',
  EMPTY: 'empty',
  DUPLICATE: 'duplicate',
} as const;

export type SourceOutcome = (typeof SourceOutcome)[keyof typeof SourceOutcome];

export interface SourceAttempt {
  readonly url: string;
  readonly outcome: SourceOutcome;
  /** Safe to show a user. Never the raw upstream error. */
  readonly detail: string | null;
}

export const ResearchStatus = {
  ANSWERED: 'answered',
  /** Nothing could be collected, so no model was called. */
  NO_SOURCES: 'no_sources',
  /** Search itself failed or returned nothing. */
  NO_RESULTS: 'no_results',
} as const;

export type ResearchStatus = (typeof ResearchStatus)[keyof typeof ResearchStatus];

export interface ResearchOptions {
  /** Candidates to consider from search. */
  readonly maxResults: number;
  /** Documents actually fetched. The cost driver, so lower than maxResults. */
  readonly maxSources: number;
  /** Characters of each document placed in the prompt. */
  readonly excerptChars: number;
}

export const DEFAULT_RESEARCH_OPTIONS: ResearchOptions = {
  maxResults: 12,
  maxSources: 5,
  excerptChars: 2_000,
};

export interface ResearchResult {
  readonly status: ResearchStatus;
  /** The verified answer: invalid markers and invented URLs removed. */
  readonly answer: string;
  /**
   * What the model actually returned, before verification edited it.
   *
   * Returned so the caller can STORE it. If the system silently corrected an
   * answer, the person relying on that answer should be able to see what was
   * corrected — keeping only the tidied version hides our own edits from the
   * only people who would want to review them. Null when no model ran.
   */
  readonly rawAnswer: string | null;
  readonly citations: readonly Citation[];
  /**
   * Every document that was fetched, in fetch order, with the excerpt that
   * was placed in the prompt. This is the ledger — including sources the
   * model chose not to cite, which is itself worth recording.
   */
  readonly collected: readonly Evidence[];
  /** Every candidate considered and what became of it. */
  readonly attempts: readonly SourceAttempt[];
  /** Integrity signals from `verifyAnswer`. Null when no model ran. */
  readonly verification: Omit<VerifiedAnswer, 'text' | 'citations'> | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly searchProvider: string;
}

/** Text shown when nothing could be collected. It promises nothing. */
export const NO_SOURCES_MESSAGE =
  'I could not retrieve any sources for this question, so I have nothing to base an answer on. ' +
  'The pages that were considered are listed below with the reason each was skipped.';

const NO_RESULTS_MESSAGE =
  'The search returned no pages to read. Try a narrower question, or supply the URLs to read directly.';

/**
 * Run one research question.
 *
 * Sequential rather than parallel on purpose. Fetching five sites at once
 * would be faster and would also mean five simultaneous requests from one IP
 * to whoever is being researched — which looks like exactly what it is. It
 * also keeps the byte and page budgets meaningful, since each decision is made
 * with the previous results known.
 */
export async function runResearch(
  question: string,
  deps: {
    search: SearchProvider;
    fetcher: PageFetcher;
    robots: RobotsChecker;
    model: ResearchModel;
  },
  options: ResearchOptions = DEFAULT_RESEARCH_OPTIONS,
): Promise<ResearchResult> {
  const attempts: SourceAttempt[] = [];

  let hits: SearchHit[];
  try {
    hits = await deps.search.search(question, options.maxResults);
  } catch {
    /*
     * Search failed. Deliberately NOT falling through to "answer anyway" —
     * an answer produced with no search is an answer from model priors, and
     * this pipeline exists precisely to not do that quietly.
     */
    return empty(ResearchStatus.NO_RESULTS, NO_RESULTS_MESSAGE, attempts, deps.search.id);
  }

  if (hits.length === 0) {
    return empty(ResearchStatus.NO_RESULTS, NO_RESULTS_MESSAGE, attempts, deps.search.id);
  }

  const collected: Array<Omit<Evidence, 'id'>> = [];
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();

  for (const hit of hits) {
    if (collected.length >= options.maxSources) break;

    const url = normaliseUrl(hit.url);
    if (!url) {
      attempts.push({ url: hit.url, outcome: SourceOutcome.BLOCKED, detail: 'Not a web address.' });
      continue;
    }
    if (seenUrls.has(url)) {
      attempts.push({ url, outcome: SourceOutcome.DUPLICATE, detail: null });
      continue;
    }
    seenUrls.add(url);

    // The publisher's own terms, checked before the request rather than after.
    let permitted: boolean;
    try {
      permitted = await deps.robots.allowed(url);
    } catch (error) {
      /*
       * A robots check can fail for two very different reasons, and reporting
       * them as one would be a false statement about a publisher.
       *
       * If the ADDRESS was refused — an internal range, a blocked scheme —
       * that is our egress policy, not the site's. Saying "their robots.txt
       * disallows it" about 169.254.169.254 both misattributes the refusal
       * and hides the real cause from whoever is reading the result.
       */
      if (isBlockedAddress(error)) {
        attempts.push({
          url,
          outcome: SourceOutcome.BLOCKED,
          detail: 'This address is not one we are permitted to fetch.',
        });
        continue;
      }
      // Anything else means the rules could not be read, so we do not fetch.
      permitted = false;
    }
    if (!permitted) {
      attempts.push({
        url,
        outcome: SourceOutcome.ROBOTS_DISALLOWED,
        detail: 'The site’s robots.txt does not permit automated access to this page.',
      });
      continue;
    }

    let page: FetchedPage;
    try {
      page = await deps.fetcher.fetch(url);
    } catch (error) {
      attempts.push({
        url,
        outcome: SourceOutcome.FETCH_FAILED,
        // The raw error may name internal hosts or carry upstream detail.
        detail: describeFetchFailure(error),
      });
      continue;
    }

    if (page.status < 200 || page.status >= 300) {
      attempts.push({
        url,
        outcome: SourceOutcome.FETCH_FAILED,
        detail: `The site returned ${page.status}.`,
      });
      continue;
    }

    const contentType = (page.contentType ?? '').toLowerCase();
    if (contentType.length > 0 && !contentType.includes('html') && !contentType.includes('text/')) {
      attempts.push({
        url,
        outcome: SourceOutcome.NOT_HTML,
        detail: 'This page is not a document we can read.',
      });
      continue;
    }

    /*
     * Deduplicate on CONTENT, not just URL. Mirrors, print views and
     * trailing-slash variants are the same document, and quoting one page
     * three times would make a single claim look corroborated.
     */
    if (seenHashes.has(page.contentHash)) {
      attempts.push({ url, outcome: SourceOutcome.DUPLICATE, detail: null });
      continue;
    }
    seenHashes.add(page.contentHash);

    const extracted = extractPage(page.body, page.finalUrl);
    if (extracted.text.trim().length === 0) {
      attempts.push({
        url,
        outcome: SourceOutcome.EMPTY,
        detail: 'No readable text on the page.',
      });
      continue;
    }

    collected.push({
      url: page.finalUrl,
      requestedUrl: url,
      title: extracted.title,
      fetchedAt: new Date(),
      contentHash: page.contentHash,
      excerpt: excerptFor(extracted.text, question, options.excerptChars),
    });
    attempts.push({ url, outcome: SourceOutcome.COLLECTED, detail: null });
  }

  /*
   * THE REFUSAL THAT MATTERS.
   *
   * No documents means no model call. Handing a model a question, an
   * instruction to cite everything, and nothing to cite is the single most
   * reliable way to produce a fabricated bibliography.
   */
  if (collected.length === 0) {
    return empty(ResearchStatus.NO_SOURCES, NO_SOURCES_MESSAGE, attempts, deps.search.id);
  }

  const ledger = buildLedger(collected);

  const result = await deps.model.synthesize({
    system: CITATION_INSTRUCTIONS,
    user: [
      `Question: ${question}`,
      '',
      'Sources:',
      // Excerpts are third-party text. They are fenced as untrusted by the
      // caller's prompt assembly; here they are only laid out.
      renderEvidence(ledger),
    ].join('\n'),
  });

  const verified = verifyAnswer(result.text, ledger);

  return {
    status: ResearchStatus.ANSWERED,
    answer: verified.text,
    rawAnswer: result.text,
    citations: verified.citations,
    collected: [...ledger.values()],
    attempts,
    verification: {
      invalidMarkers: verified.invalidMarkers,
      inventedUrls: verified.inventedUrls,
      unverifiedQuotes: verified.unverifiedQuotes,
      unsupported: verified.unsupported,
    },
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    searchProvider: deps.search.id,
  };
}

function empty(
  status: ResearchStatus,
  answer: string,
  attempts: readonly SourceAttempt[],
  searchProvider: string,
): ResearchResult {
  return {
    status,
    answer,
    rawAnswer: null,
    citations: [],
    collected: [],
    attempts,
    verification: null,
    inputTokens: 0,
    outputTokens: 0,
    searchProvider,
  };
}

/**
 * A user-facing reason a page could not be read.
 *
 * Deliberately coarse. The precise cause — which internal range was refused,
 * which host timed out — belongs in the log, not in an answer that may be
 * read by someone probing what our network can reach.
 */
/**
 * Whether an error is our own egress guard refusing an address.
 *
 * Matched on `name` rather than by importing the class: this package is a pure
 * orchestrator over injected collaborators, and taking a dependency on the
 * transport to classify one error would undo the property that makes the whole
 * pipeline testable without a network.
 */
function isBlockedAddress(error: unknown): boolean {
  return error instanceof Error && error.name === 'SsrfBlockedError';
}

function describeFetchFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'SsrfBlockedError') return 'This address is not one we are permitted to fetch.';
  if (name === 'FetchTimeoutError') return 'The site did not respond in time.';
  if (name === 'ResponseTooLargeError') return 'The page was too large to read.';
  return 'The page could not be fetched.';
}
