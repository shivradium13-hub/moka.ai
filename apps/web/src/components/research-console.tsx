'use client';

import { useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api-shared';
import { browserApi } from '@/lib/api-browser';
import { Button, Card, CardHeader, ErrorNote, Field } from '@/components/ui';

interface Citation {
  id: number;
  url: string;
  title: string | null;
  fetchedAt: string;
  contentHash: string;
  quoteVerified: boolean | null;
}

interface Attempt {
  url: string;
  outcome: string;
  detail: string | null;
}

interface Verification {
  invalidMarkers: number[];
  inventedUrls: string[];
  unverifiedQuotes: string[];
  unsupported: boolean;
}

interface RunResult {
  runId: string;
  status: string;
  answer: string;
  citations: Citation[];
  attempts: Attempt[];
  verification: Verification | null;
  searchProvider: string;
}

interface Capabilities {
  providers: Array<{ id: string; label: string; configured: boolean; note: string | null }>;
}

/**
 * The research console.
 *
 * The unusual thing on this page is that it shows its own working. A research
 * answer is only worth as much as its sources, so the UI reports what was
 * fetched, what was skipped and why, and — when the verifier corrected the
 * model — that it did so.
 *
 * That last part is deliberate and slightly uncomfortable. It would look
 * better to quietly strip a fabricated citation and show a clean answer. It
 * would also mean a user never learns that the model invents sources, which is
 * the single most useful thing for them to know when deciding how much to
 * trust the paragraph they are reading.
 */
export function ResearchConsole({ capabilities }: { capabilities: Capabilities }) {
  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searxng = capabilities.providers.find((p) => p.id === 'searxng');
  const keywordSearch = searxng?.configured ?? false;

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    setResult(null);

    const form = new FormData(event.currentTarget);
    const urls = String(form.get('urls') ?? '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    try {
      setResult(
        await browserApi<RunResult>('/v1/research', {
          method: 'POST',
          body: { question: String(form.get('question') ?? ''), urls },
        }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The research run failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/*
        Stated up front rather than discovered from an empty result. A research
        feature that appears to search the web and does not is exactly the kind
        of quiet failure this phase exists to avoid.
      */}
      {keywordSearch ? null : (
        <div className="rounded-lg bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <p className="font-medium">No search engine is configured.</p>
          <p className="mt-0.5">
            {searxng?.note ?? 'Supply the URLs you want read.'} Research still works — give it the
            pages to read and it will read them.
          </p>
        </div>
      )}

      <Card>
        <CardHeader
          title="Research a question"
          description="Every source in the answer is a page that was actually fetched. Nothing is cited that could not be read."
        />
        <form onSubmit={run} className="space-y-4 px-5 py-4">
          <ErrorNote message={error} />
          <Field
            label="Question"
            name="question"
            required
            placeholder="What does their pricing page say about seat limits?"
          />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[--color-muted]">
              Pages to read {keywordSearch ? '(optional)' : '(required)'}
            </span>
            <textarea
              name="urls"
              rows={3}
              placeholder="https://example.com/pricing&#10;https://docs.example.com/limits"
              className="w-full rounded-lg border border-[--color-line] bg-white px-3 py-2 font-mono text-xs outline-none focus:border-[--color-accent]"
            />
            <span className="mt-1 block text-xs text-[--color-muted]">
              {keywordSearch
                ? 'Give URLs to read exactly those pages, or leave blank to search.'
                : 'One per line. Sites that disallow automated access in robots.txt are skipped.'}
            </span>
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Reading…' : 'Run research'}
          </Button>
        </form>
      </Card>

      {result ? <ResultView result={result} /> : null}
    </div>
  );
}

function ResultView({ result }: { result: RunResult }) {
  const v = result.verification;
  const corrected = v ? v.invalidMarkers.length > 0 || v.inventedUrls.length > 0 : false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Answer"
          description={
            result.status === 'answered'
              ? `From ${result.citations.length} source${result.citations.length === 1 ? '' : 's'} · ${result.searchProvider === 'seed' ? 'pages you supplied' : 'web search'}`
              : 'No answer could be produced.'
          }
        />
        <div className="px-5 py-4">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.answer}</p>
        </div>

        {result.citations.length > 0 ? (
          <div className="border-t border-[--color-line] px-5 py-4">
            <p className="mb-2 text-xs font-medium text-[--color-muted]">Sources</p>
            <ol className="space-y-1.5">
              {result.citations.map((citation) => (
                <li key={citation.id} className="text-xs">
                  <span className="mr-1.5 font-mono text-[--color-muted]">[{citation.id}]</span>
                  {/*
                    rel="noopener noreferrer" and no target-blank trust: these
                    URLs came from pages we fetched, which is not the same as
                    pages we vouch for.
                  */}
                  <a
                    href={citation.url}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="text-[--color-accent] hover:underline"
                  >
                    {citation.title ?? citation.url}
                  </a>
                  <span className="ml-1.5 text-[--color-muted]">
                    · read {new Date(citation.fetchedAt).toLocaleString()}
                  </span>
                  {citation.quoteVerified === false ? (
                    <span className="ml-1.5 text-amber-800">· quote not found in this page</span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </Card>

      {/*
        The verifier's report. Shown, not hidden: a user deciding how much to
        trust a paragraph is better served by knowing the model invented two
        references in it than by a tidier page.
      */}
      {corrected ? (
        <Card className="border-amber-300">
          <CardHeader
            title="This answer was corrected"
            description="The assistant referred to sources that do not exist. They were removed before you saw it."
          />
          <div className="space-y-1 px-5 py-4 text-xs">
            {v!.invalidMarkers.length > 0 ? (
              <p>
                Removed {v!.invalidMarkers.length} citation
                {v!.invalidMarkers.length === 1 ? '' : 's'} to sources that were never fetched.
              </p>
            ) : null}
            {v!.inventedUrls.length > 0 ? (
              <p>
                Removed {v!.inventedUrls.length} link
                {v!.inventedUrls.length === 1 ? '' : 's'} that appeared in none of the pages read.
              </p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {result.attempts.length > 0 ? (
        <Card>
          <CardHeader
            title="Pages considered"
            description="Two sources out of nine is a different answer from two out of two."
          />
          <ul className="divide-y divide-[--color-line]">
            {result.attempts.map((attempt, index) => (
              <li key={`${attempt.url}-${index}`} className="flex items-start gap-3 px-5 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{attempt.url}</span>
                <span className="shrink-0 text-xs text-[--color-muted]">
                  {attempt.outcome === 'collected' ? 'read' : (attempt.detail ?? attempt.outcome)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
