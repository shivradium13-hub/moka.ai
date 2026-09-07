/**
 * robots.txt parsing and matching (master prompt §2, §14).
 *
 * WHY THIS IS A SECURITY FILE AND NOT A POLITENESS FILE
 *
 * The brief forbids bypassing "provider authentication, licensing, API
 * restrictions or terms". A site's robots.txt is the machine-readable form of
 * its terms for automated clients. Ignoring it is not a rudeness; it is
 * fetching material the publisher has said in writing not to fetch, on a
 * tenant's behalf, from an IP that belongs to us.
 *
 * So this lives next to `safeFetch` rather than in the crawler: SSRF rules
 * decide *which addresses* we may dial, and robots rules decide *which paths
 * we are permitted to*. Both are egress policy, both are the kind of thing
 * that gets quietly dropped under deadline, and both belong where a reviewer
 * looking for outbound-traffic controls will find them.
 *
 * WHAT THIS IMPLEMENTS
 * The de-facto standard as described by RFC 9309: group matching on
 * `User-agent`, `Allow`/`Disallow` with longest-match-wins and Allow winning
 * ties, `*` and `$` wildcards, plus `Crawl-delay` and `Sitemap` which are
 * extensions RFC 9309 does not standardise but which are near-universal.
 *
 * WHAT IT DOES NOT
 * No `noindex` meta handling (that is an indexing directive, not a fetch one),
 * and no attempt to guess intent from a malformed file. A robots.txt we cannot
 * parse is treated as permissive, matching the standard — but a robots.txt we
 * could not FETCH is handled by the caller, and the caller's default is the
 * cautious one. See `robotsFetchFailurePolicy` below.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
  /** Precedence: longer patterns win, and Allow wins an exact-length tie. */
  readonly length: number;
}

export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelaySeconds: number | null;
}

export interface RobotsTxt {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
  /** True when the file contained no directives we understood. */
  readonly empty: boolean;
}

const EMPTY: RobotsTxt = { groups: [], sitemaps: [], empty: true };

/**
 * Parse a robots.txt body.
 *
 * Deliberately tolerant of the mess real files contain: BOMs, CRLF, comments
 * mid-line, arbitrary casing, and directives whose value is empty. An
 * unparseable line is skipped rather than aborting the file, because the
 * alternative — treating a file with one typo as absent — would silently make
 * us more permissive on exactly the sites that tried to restrict us.
 */
export function parseRobotsTxt(body: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];

  let agents: string[] = [];
  let rules: RobotsRule[] = [];
  let crawlDelay: number | null = null;
  // Consecutive `User-agent` lines form ONE group. A rule line ends the run,
  // so the next agent line starts a new group.
  let collectingAgents = false;
  let understood = false;

  const flush = (): void => {
    if (agents.length > 0 && (rules.length > 0 || crawlDelay !== null)) {
      groups.push({ agents, rules, crawlDelaySeconds: crawlDelay });
    }
    agents = [];
    rules = [];
    crawlDelay = null;
  };

  // A literal BOM in source is an invisible character; the codepoint check is
  // the same test and can be read.
  const withoutBom = body.charCodeAt(0) === 0xfeff ? body.slice(1) : body;

  for (const rawLine of withoutBom.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]!.trim();
    if (line.length === 0) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (field) {
      case 'user-agent': {
        if (!collectingAgents) flush();
        collectingAgents = true;
        if (value.length > 0) {
          agents.push(value.toLowerCase());
          understood = true;
        }
        break;
      }
      case 'disallow':
      case 'allow': {
        collectingAgents = false;
        understood = true;
        /*
         * An empty `Disallow:` means "nothing is disallowed" and is the
         * conventional way to permit everything. Recording it as a zero-length
         * rule would make it match every path, so it is dropped instead — the
         * absence of any rule already permits.
         */
        if (field === 'disallow' && value.length === 0) break;
        if (value.length === 0) break;
        rules.push({ allow: field === 'allow', path: value, length: value.length });
        break;
      }
      case 'crawl-delay': {
        collectingAgents = false;
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
          crawlDelay = Math.min(parsed, 300);
          understood = true;
        }
        break;
      }
      case 'sitemap': {
        // Sitemap is site-wide, not group-scoped, so it does not end a run.
        if (value.length > 0) {
          sitemaps.push(value);
          understood = true;
        }
        break;
      }
      default:
        break;
    }
  }

  flush();

  return understood ? { groups, sitemaps, empty: groups.length === 0 } : EMPTY;
}

/**
 * The group that applies to a given user agent.
 *
 * Most-specific wins: an exact (case-insensitive substring) match on our token
 * beats `*`. If several specific groups match, the longest agent token wins,
 * which is what stops `moka` and `mokabot` from being ambiguous.
 */
export function groupFor(robots: RobotsTxt, userAgent: string): RobotsGroup | null {
  const token = userAgent.toLowerCase();
  let best: { group: RobotsGroup; score: number } | null = null;

  for (const group of robots.groups) {
    for (const agent of group.agents) {
      // `*` is the fallback and scores lowest, so any named match beats it.
      const score = agent === '*' ? 0 : token.includes(agent) ? agent.length : -1;
      if (score < 0) continue;
      if (!best || score > best.score) best = { group, score };
    }
  }

  return best?.group ?? null;
}

/**
 * Whether `path` may be fetched.
 *
 * RFC 9309 §2.2.2: the most specific rule wins, measured by pattern length,
 * and Allow wins a tie. That tie-break matters — a site writing
 * `Disallow: /admin` plus `Allow: /admin` means the permissive one, and
 * getting it backwards would make us refuse pages we are welcome to read.
 *
 * With no matching group, or no rules, everything is permitted. That is the
 * standard's default and it is the right one: a site with no robots.txt has
 * not restricted anything.
 */
export function isPathAllowed(robots: RobotsTxt, userAgent: string, path: string): boolean {
  const group = groupFor(robots, userAgent);
  if (!group || group.rules.length === 0) return true;

  const target = normalisePath(path);
  let winner: RobotsRule | null = null;

  for (const rule of group.rules) {
    if (!matchesPattern(rule.path, target)) continue;
    if (
      !winner ||
      rule.length > winner.length ||
      (rule.length === winner.length && rule.allow && !winner.allow)
    ) {
      winner = rule;
    }
  }

  return winner ? winner.allow : true;
}

export function crawlDelayFor(robots: RobotsTxt, userAgent: string): number | null {
  return groupFor(robots, userAgent)?.crawlDelaySeconds ?? null;
}

/**
 * Match a robots path pattern against a request path.
 *
 * `*` matches any run of characters and `$` anchors the end. Implemented by
 * translating to a regular expression with everything else escaped — the
 * escaping is the part that matters, since a pattern is attacker-controlled
 * text from a third-party site and an unescaped `(` or `+` would either throw
 * or quietly change the meaning.
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const source = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  try {
    return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
  } catch {
    // A pattern that will not compile is treated as non-matching rather than
    // as blocking everything: a broken third-party file must not be able to
    // stop us reading the rest of a site, nor to open it up.
    return false;
  }
}

function normalisePath(path: string): string {
  if (path.length === 0) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * What to do when robots.txt cannot be fetched.
 *
 * RFC 9309 §2.3.1 distinguishes these, and the distinction is worth keeping
 * because the failure modes are genuinely different:
 *
 *   404 / 410       → the site has no robots.txt. Everything is permitted.
 *   401 / 403       → the site refused us. Treat the whole site as disallowed;
 *                     a server that will not show us its rules has not invited
 *                     us to guess them.
 *   5xx / network   → unavailable. Treat as disallowed for this run rather
 *                     than crawling blind. The standard suggests caching a
 *                     previous result; we have none on a first visit, and the
 *                     cautious reading is the one that cannot embarrass a
 *                     tenant.
 */
export function robotsFetchFailurePolicy(status: number | 'network_error'): 'allow' | 'deny' {
  if (status === 'network_error') return 'deny';
  if (status === 404 || status === 410) return 'allow';
  if (status >= 200 && status < 300) return 'allow';
  return 'deny';
}

/**
 * The user agent we present when crawling.
 *
 * Identifies the software and gives a contact path, which is what lets a site
 * owner block us specifically rather than blocking every unknown client. An
 * anonymous or browser-impersonating agent string would be a small deception
 * with no upside.
 */
export const CRAWLER_USER_AGENT = 'MokaAI-Crawler/1.0 (+https://moka.ai/bot)';

/** The token a robots.txt would name to address us. */
export const CRAWLER_TOKEN = 'mokaai-crawler';
