import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH, parseQuery } from './query.js';
import { RRF_K, reciprocalRankFusion } from './types.js';

describe('parseQuery', () => {
  it('extracts terms and builds an OR clause', () => {
    const parsed = parseQuery('refund policy window');
    expect(parsed.terms).toEqual(['refund', 'policy', 'window']);
    expect(parsed.tsquery).toBe('refund | policy | window');
  });

  it('drops stopwords', () => {
    expect(parseQuery('what is the refund policy').terms).toEqual(['what', 'refund', 'policy']);
  });

  it('returns null when nothing usable remains', () => {
    expect(parseQuery('the and of').tsquery).toBeNull();
    expect(parseQuery('   ').tsquery).toBeNull();
    expect(parseQuery('!!!').tsquery).toBeNull();
  });

  it('treats a quoted phrase as adjacent terms', () => {
    const parsed = parseQuery('"refund window" policy');
    expect(parsed.phrases).toEqual(['refund window']);
    expect(parsed.tsquery).toContain('refund <-> window');
  });

  /*
   * SECURITY: user input reaches to_tsquery. Rather than escaping the operator
   * language, terms are allowlisted to letters/digits/hyphen/apostrophe, so no
   * operator character can survive extraction at all.
   */
  describe('tsquery operator injection', () => {
    const hostile = [
      'refund & policy',
      'refund | policy',
      'refund !policy',
      'refund:*',
      "refund' | 'x",
      'refund <-> policy',
      'a & (b | c)',
      'refund\\:*',
      "'; DROP TABLE knowledge_chunks; --",
      'refund:A|B:*',
    ];

    for (const input of hostile) {
      it(`neutralises ${JSON.stringify(input)}`, () => {
        const parsed = parseQuery(input);
        for (const term of parsed.terms) {
          expect(term).toMatch(/^[\p{L}\p{N}'-]+$/u);
        }
        if (parsed.tsquery) {
          // Only operators WE generated may appear.
          const withoutOurOperators = parsed.tsquery
            .replace(/ \| /g, ' ')
            .replace(/ & /g, ' ')
            .replace(/ <-> /g, ' ');
          expect(withoutOurOperators).not.toMatch(/[&|!():*\\]/);
        }
      });
    }

    it('does not let a term become a weight or prefix operator', () => {
      // ':*' (prefix match) and ':A' (weight label) are tsquery operators.
      // Both are split away, and the residual single character is dropped as
      // noise, leaving only the real term.
      expect(parseQuery('refund:*').terms).toEqual(['refund']);
      expect(parseQuery('refund:A').terms).toEqual(['refund']);
      expect(parseQuery('refund:ABC').terms).toEqual(['refund', 'abc']);
    });
  });

  it('caps query length', () => {
    const parsed = parseQuery('word '.repeat(500));
    expect(parsed.terms.length).toBeLessThanOrEqual(24);
    expect((parsed.tsquery ?? '').length).toBeLessThan(MAX_QUERY_LENGTH * 2);
  });

  it('keeps intra-word hyphens and apostrophes', () => {
    expect(parseQuery("multi-factor customer's").terms).toEqual(['multi-factor', "customer's"]);
  });

  it('strips leading and trailing punctuation from terms', () => {
    expect(parseQuery("--refund-- 'policy'").terms).toEqual(['refund', 'policy']);
  });

  it('handles non-Latin scripts', () => {
    const parsed = parseQuery('返金 ポリシー');
    expect(parsed.terms.length).toBeGreaterThan(0);
  });
});

describe('reciprocalRankFusion', () => {
  type Row = { id: string };
  const key = (row: Row): string => row.id;

  it('returns an empty list for no input', () => {
    expect(reciprocalRankFusion<Row>([], key)).toEqual([]);
  });

  it('preserves order for a single list', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const fused = reciprocalRankFusion([{ name: 'sparse', items }], key);
    expect(fused.map((f) => f.key)).toEqual(['a', 'b', 'c']);
  });

  /*
   * The core property: an item ranked moderately by BOTH retrievers should beat
   * one ranked top by only one. That is what makes hybrid retrieval better than
   * either half.
   */
  it('rewards agreement between retrievers', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'dense', items: [{ id: 'only-dense' }, { id: 'both' }] },
        { name: 'sparse', items: [{ id: 'only-sparse' }, { id: 'both' }] },
      ],
      key,
    );
    expect(fused[0]?.key).toBe('both');
  });

  it('records the contributing retriever and rank', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'dense', items: [{ id: 'x' }] },
        { name: 'sparse', items: [{ id: 'y' }, { id: 'x' }] },
      ],
      key,
    );
    const x = fused.find((f) => f.key === 'x');
    expect(x?.signals).toEqual({ dense: 1, sparse: 2 });
  });

  it('uses only ordinal rank, never the underlying score scale', () => {
    // Identical ranks must produce identical fused scores regardless of the
    // incomparable native scores (cosine distance vs ts_rank).
    const a = reciprocalRankFusion([{ name: 's', items: [{ id: 'p' }] }], key);
    const b = reciprocalRankFusion([{ name: 's', items: [{ id: 'q' }] }], key);
    expect(a[0]?.score).toBe(b[0]?.score);
    expect(a[0]?.score).toBeCloseTo(1 / (RRF_K + 1));
  });

  it('sorts descending by fused score', () => {
    const fused = reciprocalRankFusion(
      [{ name: 's', items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }],
      key,
    );
    const scores = fused.map((f) => f.score);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });
});
