/**
 * Grounding and citation policy for customer-facing answers (§24, §45).
 *
 * THE PROBLEM THIS SOLVES
 * A support chatbot that answers from the model's own priors will confidently
 * describe a refund policy the organization does not have, to a customer who
 * will then hold them to it. That is not a hallucination in the abstract; it
 * is a false statement made to a member of the public in the organization's
 * name, on the organization's own website.
 *
 * So the default is: no retrieved passage, no answer. The bot says it does not
 * know and offers a human. That is a worse demo and a better product.
 *
 * An operator may switch grounding off per chatbot. It is not hidden, and the
 * builder says plainly what it means, because there are legitimate uses (a
 * general-purpose concierge) and pretending otherwise would just push people
 * to work around it.
 */

export interface RetrievedPassage {
  readonly chunkId: string;
  readonly documentId: string;
  readonly sourceId: string;
  readonly documentTitle: string;
  readonly documentUrl: string | null;
  readonly content: string;
  readonly page: number | null;
  readonly section: string | null;
}

export interface Citation {
  readonly chunkId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  /** Present only when the source document was itself a public URL. */
  readonly documentUrl: string | null;
  readonly page: number | null;
  readonly section: string | null;
}

export interface GroundingPolicy {
  /** When true, the bot may only answer from retrieved passages. */
  readonly requireGrounding: boolean;
  /** How many passages must be found before an answer is attempted. */
  readonly minPassages: number;
  /** Upper bound on passages placed in the prompt, for cost and context. */
  readonly maxPassages: number;
}

export const DEFAULT_GROUNDING: GroundingPolicy = {
  requireGrounding: true,
  minPassages: 1,
  maxPassages: 6,
};

export type GroundingDecision =
  | { readonly answerable: true; readonly passages: readonly RetrievedPassage[] }
  | { readonly answerable: false; readonly reason: 'no_passages'; readonly message: string };

/**
 * The standard refusal.
 *
 * Written to be useful rather than apologetic: it says what happened, does not
 * invent a partial answer, and points at the one action that will actually
 * help. It never mentions knowledge bases, sources or retrieval — a visitor
 * has no model of our internals and telling them "no chunks matched" is both
 * confusing and a small information leak about how the system is built.
 */
export const NOT_IN_KNOWLEDGE_MESSAGE =
  "I don't have information about that. If you'd like, I can pass this to a person who can help.";

/**
 * Decide whether an answer may be attempted, and with which passages.
 *
 * A NOTE ON WHAT IS NOT HERE
 * There is no relevance-score threshold. Retrieval currently fuses two lexical
 * retrievers with Reciprocal Rank Fusion, and an RRF score is ordinal — it
 * says this passage ranked above that one, not that either is relevant. A
 * numeric cut-off on it would look like a quality gate while behaving like a
 * random one. The honest gate available today is "did anything match at all".
 *
 * TODO(§B1): once pgvector is available, add a cosine-similarity floor, which
 * IS a meaningful measure of whether the corpus contains anything on topic.
 */
export function decideGrounding(
  passages: readonly RetrievedPassage[],
  policy: GroundingPolicy = DEFAULT_GROUNDING,
): GroundingDecision {
  const selected = passages.slice(0, Math.max(1, policy.maxPassages));

  if (!policy.requireGrounding) {
    return { answerable: true, passages: selected };
  }

  if (selected.length < Math.max(1, policy.minPassages)) {
    return { answerable: false, reason: 'no_passages', message: NOT_IN_KNOWLEDGE_MESSAGE };
  }

  return { answerable: true, passages: selected };
}

/**
 * Citations for the passages that were actually placed in the prompt.
 *
 * Deliberately derived from what was RETRIEVED, not from what the model claims
 * to have used. Asking a model which documents it relied on produces a
 * plausible list, not a true one, and a fabricated citation is worse than none
 * — it converts an unsupported answer into an apparently sourced one.
 *
 * The honest reading of what these mean: "here is what the assistant was shown
 * when it wrote this", not "here is the sentence this claim came from".
 */
export function citationsFor(passages: readonly RetrievedPassage[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const passage of passages) {
    if (seen.has(passage.chunkId)) continue;
    seen.add(passage.chunkId);
    citations.push({
      chunkId: passage.chunkId,
      documentId: passage.documentId,
      documentTitle: passage.documentTitle,
      documentUrl: passage.documentUrl,
      page: passage.page,
      section: passage.section,
    });
  }

  return citations;
}
