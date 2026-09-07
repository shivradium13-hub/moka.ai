import { describe, expect, it } from 'vitest';
import {
  CITATION_INSTRUCTIONS,
  buildLedger,
  containsQuote,
  renderEvidence,
  verifyAnswer,
  type Evidence,
} from './citations.js';

/**
 * THE PHASE 7 GATE: no fabricated citations.
 *
 * Every test here assumes the model misbehaved. That is deliberate, and it is
 * the same posture as the injection suite: a test that passes because the
 * model happened to behave is a test of the model, not of us. Models invent
 * bibliographies reliably enough that the interesting question is only ever
 * "what happens when it does".
 */

const FETCHED_AT = new Date('2026-09-07T10:00:00Z');

function evidence(overrides: Partial<Omit<Evidence, 'id'>> = {}): Omit<Evidence, 'id'> {
  return {
    url: 'https://example.com/pricing',
    requestedUrl: 'https://example.com/pricing',
    title: 'Pricing',
    fetchedAt: FETCHED_AT,
    contentHash: 'a'.repeat(64),
    excerpt: 'The Pro plan costs 40 dollars per seat per month and includes priority support.',
    ...overrides,
  };
}

const LEDGER = buildLedger([
  evidence(),
  evidence({
    url: 'https://docs.example.com/limits',
    requestedUrl: 'https://docs.example.com/limits',
    title: 'Rate limits',
    excerpt: 'API requests are limited to 600 per minute on the Pro plan.',
  }),
]);

/* ========================================================================== */
/* The ledger                                                                 */
/* ========================================================================== */

describe('the ledger', () => {
  it('assigns ids in fetch order', () => {
    expect([...LEDGER.keys()]).toEqual([1, 2]);
    expect(LEDGER.get(1)!.title).toBe('Pricing');
  });

  it('records the FINAL url, so a redirect cannot be cited as its origin', () => {
    const redirected = buildLedger([
      evidence({
        requestedUrl: 'https://example.com/go?to=pricing',
        url: 'https://example.com/pricing',
      }),
    ]);
    expect(redirected.get(1)!.url).toBe('https://example.com/pricing');
    expect(redirected.get(1)!.requestedUrl).not.toBe(redirected.get(1)!.url);
  });
});

describe('what the model is shown', () => {
  const rendered = renderEvidence(LEDGER);

  it('gives it a number and a host, never a URL', () => {
    /*
     * The point of the whole design. Putting the URL in the prompt would place
     * the exact string we are trying to stop it producing directly into its
     * context, where copying it is the path of least resistance.
     */
    expect(rendered).toContain('[1] Pricing — example.com');
    expect(rendered).not.toContain('https://');
    expect(rendered).not.toContain('/pricing');
  });

  it('includes the excerpt text verbatim', () => {
    expect(rendered).toContain('40 dollars per seat');
  });
});

/* ========================================================================== */
/* Marker verification                                                        */
/* ========================================================================== */

describe('citation markers', () => {
  it('keeps a marker that names a real source', () => {
    const result = verifyAnswer('The Pro plan is 40 dollars per seat [1].', LEDGER);
    expect(result.text).toBe('The Pro plan is 40 dollars per seat [1].');
    expect(result.citations.map((c) => c.id)).toEqual([1]);
    expect(result.invalidMarkers).toEqual([]);
    expect(result.unsupported).toBe(false);
  });

  it('REMOVES a marker naming a source that does not exist', () => {
    /*
     * The classic fabrication: given two sources, the model cites a fourth.
     * Leaving `[4]` in place would show the reader a citation for a claim that
     * has none — the precise deception this exists to prevent.
     */
    const result = verifyAnswer('It also integrates with Salesforce [4].', LEDGER);
    expect(result.text).toBe('It also integrates with Salesforce.');
    expect(result.text).not.toContain('[4]');
    expect(result.invalidMarkers).toEqual([4]);
    expect(result.unsupported).toBe(true);
  });

  it('keeps the valid half of a mixed marker', () => {
    const result = verifyAnswer('Both are true [1, 7].', LEDGER);
    expect(result.text).toBe('Both are true [1].');
    expect(result.invalidMarkers).toEqual([7]);
    expect(result.citations.map((c) => c.id)).toEqual([1]);
  });

  it('handles a multi-source marker where all are real', () => {
    const result = verifyAnswer('Both documents agree [1, 2].', LEDGER);
    expect(result.text).toBe('Both documents agree [1, 2].');
    expect(result.citations.map((c) => c.id)).toEqual([1, 2]);
  });

  it('orders citations by first appearance, not by number', () => {
    const result = verifyAnswer('Limits first [2], then price [1].', LEDGER);
    expect(result.citations.map((c) => c.id)).toEqual([2, 1]);
  });

  it('deduplicates a source cited several times', () => {
    const result = verifyAnswer('Price [1]. Also price [1].', LEDGER);
    expect(result.citations).toHaveLength(1);
  });

  it('reports an answer with no valid citation as unsupported', () => {
    const result = verifyAnswer('I believe the plan costs about forty dollars.', LEDGER);
    expect(result.unsupported).toBe(true);
    expect(result.citations).toEqual([]);
  });

  it('does not treat an honest "I could not find this" as an error', () => {
    // Uncited, and correct. `unsupported` is reported rather than acted on for
    // exactly this reason — the caller decides what an uncited answer means.
    const result = verifyAnswer('The sources do not mention refund terms.', LEDGER);
    expect(result.unsupported).toBe(true);
    expect(result.invalidMarkers).toEqual([]);
    expect(result.inventedUrls).toEqual([]);
  });

  it('tidies the space left behind by a removed marker', () => {
    const result = verifyAnswer('A claim [9] , and another.', LEDGER);
    expect(result.text).not.toMatch(/\s{2,}/);
    expect(result.text).not.toMatch(/\s+,/);
  });

  it('cannot be confused by a number in square brackets that is not a citation', () => {
    // `[0]` names nothing, so it is removed like any other invalid marker
    // rather than being silently accepted as source zero.
    const result = verifyAnswer('Array index [0] is the first element.', LEDGER);
    expect(result.invalidMarkers).toEqual([0]);
  });
});

/* ========================================================================== */
/* URL verification                                                           */
/* ========================================================================== */

describe('URLs in the answer', () => {
  it('REMOVES a URL that appears in no fetched document', () => {
    /*
     * The signature failure. The URL is well-formed, plausible, on the right
     * domain — and was never fetched, so it may point anywhere or nowhere.
     */
    const result = verifyAnswer(
      'See the full terms at https://example.com/terms-of-service for details.',
      LEDGER,
    );
    expect(result.text).not.toContain('https://example.com/terms-of-service');
    expect(result.text).toContain('[link removed]');
    expect(result.inventedUrls).toEqual(['https://example.com/terms-of-service']);
  });

  it('KEEPS a URL that genuinely appeared in a fetched page', () => {
    // A model quoting a link out of a document it read is reporting, not
    // inventing, and removing it would lose real information.
    const withLink = buildLedger([
      evidence({
        excerpt: 'Full terms are published at https://example.com/legal/terms each year.',
      }),
    ]);
    const result = verifyAnswer('The terms are at https://example.com/legal/terms [1].', withLink);
    expect(result.text).toContain('https://example.com/legal/terms');
    expect(result.inventedUrls).toEqual([]);
  });

  it('does not swallow the sentence punctuation after a URL', () => {
    const result = verifyAnswer('Read https://example.com/gone.', LEDGER);
    expect(result.text).toBe('Read [link removed].');
    expect(result.inventedUrls).toEqual(['https://example.com/gone']);
  });

  it('catches a URL on a domain that was never fetched at all', () => {
    const result = verifyAnswer('Compare with https://competitor.test/pricing [1].', LEDGER);
    expect(result.inventedUrls).toEqual(['https://competitor.test/pricing']);
  });

  it('catches several invented URLs in one answer', () => {
    const result = verifyAnswer(
      'See https://a.test/one and also https://b.test/two.',
      LEDGER,
    );
    expect(result.inventedUrls).toHaveLength(2);
  });

  it('leaves a bare domain alone, having no way to verify or fault it', () => {
    // Not a citable link, and stripping ordinary prose that names a company
    // would be worse than the marginal risk of leaving it.
    const result = verifyAnswer('Documented on docs.example.com [2].', LEDGER);
    expect(result.text).toContain('docs.example.com');
    expect(result.inventedUrls).toEqual([]);
  });
});

/* ========================================================================== */
/* Quote verification                                                         */
/* ========================================================================== */

describe('quotations', () => {
  it('confirms a quote that is really in the cited source', () => {
    const result = verifyAnswer(
      'The page says "The Pro plan costs 40 dollars per seat per month" [1].',
      LEDGER,
    );
    expect(result.unverifiedQuotes).toEqual([]);
    expect(result.citations[0]!.quoteVerified).toBe(true);
  });

  it('FLAGS a quote that is not in the cited source', () => {
    const result = verifyAnswer(
      'The page says "The Pro plan is free for the first six months" [1].',
      LEDGER,
    );
    expect(result.unverifiedQuotes).toHaveLength(1);
    expect(result.citations[0]!.quoteVerified).toBe(false);
  });

  it('flags rather than deletes, because models paraphrase inside quotes', () => {
    // Deleting on a miss would mangle honest answers. The signal is reported
    // and the caller decides what it is worth.
    const answer = 'It says "The Pro plan is free for six months" [1].';
    const result = verifyAnswer(answer, LEDGER);
    expect(result.text).toContain('free for six months');
  });

  it('leaves quoteVerified null when a citation supports a paraphrase', () => {
    const result = verifyAnswer('Pricing is per seat and monthly [1].', LEDGER);
    expect(result.citations[0]!.quoteVerified).toBeNull();
  });

  it('ignores whitespace and curly quotes when matching', () => {
    const reflowed = buildLedger([
      evidence({ excerpt: 'The Pro plan costs   40 dollars\nper seat per month.' }),
    ]);
    expect(
      containsQuote(reflowed.get(1)!.excerpt, 'The Pro plan costs 40 dollars per seat per month'),
    ).toBe(true);
  });

  it('does not accept a paraphrase as a quotation', () => {
    expect(
      containsQuote(
        'The Pro plan costs 40 dollars per seat per month.',
        'The Pro tier is priced at forty dollars for each seat monthly',
      ),
    ).toBe(false);
  });

  it('ignores short quoted terms, which are not quotations', () => {
    const result = verifyAnswer('The plan is called "Pro" [1].', LEDGER);
    expect(result.unverifiedQuotes).toEqual([]);
  });
});

/* ========================================================================== */
/* The combined worst case                                                    */
/* ========================================================================== */

describe('a thoroughly fabricated answer', () => {
  const result = verifyAnswer(
    [
      'The Pro plan costs 40 dollars per seat [1]. It includes unlimited storage [5]',
      'and a 99.99% uptime guarantee, documented at https://example.com/sla [6].',
      'Their CEO said "we will never raise prices" [1].',
    ].join(' '),
    LEDGER,
  );

  it('keeps the one real citation', () => {
    expect(result.citations.map((c) => c.id)).toEqual([1]);
  });

  it('strips both invented markers', () => {
    expect(result.invalidMarkers).toEqual([5, 6]);
    expect(result.text).not.toContain('[5]');
    expect(result.text).not.toContain('[6]');
  });

  it('strips the invented URL', () => {
    expect(result.inventedUrls).toEqual(['https://example.com/sla']);
    expect(result.text).not.toContain('example.com/sla');
  });

  it('flags the invented quotation', () => {
    expect(result.unverifiedQuotes).toHaveLength(1);
    expect(result.citations[0]!.quoteVerified).toBe(false);
  });

  it('leaves nothing citable that was not fetched', () => {
    // The property in one assertion: every URL a reader can see came from the
    // ledger, and every ledger entry came from a real fetch.
    for (const citation of result.citations) {
      expect([...LEDGER.values()].map((e) => e.url)).toContain(citation.url);
    }
    expect(result.text).not.toMatch(/https?:\/\/(?!.*\[link removed\])/);
  });
});

describe('the prompt instructions', () => {
  it('tell the model to cite by number and never to write a URL', () => {
    expect(CITATION_INSTRUCTIONS).toMatch(/square brackets/i);
    expect(CITATION_INSTRUCTIONS).toMatch(/never write a URL/i);
  });

  it('make "I do not know" an acceptable answer', () => {
    // Without this, the cheapest way for a model to satisfy "cite everything"
    // is to invent something citable.
    expect(CITATION_INSTRUCTIONS).toMatch(/say so plainly/i);
  });
});
