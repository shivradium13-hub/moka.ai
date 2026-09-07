import { describe, expect, it } from 'vitest';
import {
  CRAWLER_TOKEN,
  CRAWLER_USER_AGENT,
  crawlDelayFor,
  groupFor,
  isPathAllowed,
  matchesPattern,
  parseRobotsTxt,
  robotsFetchFailurePolicy,
} from './robots.js';

/**
 * robots.txt is a permission file, and this suite treats it as one.
 *
 * The failure that matters is being MORE permissive than the site asked, so
 * most of these assert a refusal. The cases are the ones real files produce:
 * consecutive user-agent lines, an empty Disallow meaning "allow all",
 * longest-match precedence, and patterns containing regex metacharacters.
 */

describe('parsing', () => {
  it('reads a simple group', () => {
    const robots = parseRobotsTxt(`
User-agent: *
Disallow: /admin
Disallow: /private
`);
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]!.agents).toEqual(['*']);
    expect(robots.groups[0]!.rules).toHaveLength(2);
  });

  it('treats consecutive user-agent lines as ONE group', () => {
    // A group addressed to several agents. Splitting it would apply the rules
    // to only the last one named.
    const robots = parseRobotsTxt(`
User-agent: googlebot
User-agent: mokaai-crawler
Disallow: /secret
`);
    expect(robots.groups).toHaveLength(1);
    expect(robots.groups[0]!.agents).toEqual(['googlebot', 'mokaai-crawler']);
  });

  it('starts a new group when an agent line follows a rule line', () => {
    const robots = parseRobotsTxt(`
User-agent: googlebot
Disallow: /g

User-agent: *
Disallow: /everyone
`);
    expect(robots.groups).toHaveLength(2);
  });

  it('ignores comments, blank lines and a BOM', () => {
    const robots = parseRobotsTxt('﻿# a comment\n\nUser-agent: *  # trailing\nDisallow: /x\n');
    expect(robots.groups[0]!.rules[0]!.path).toBe('/x');
  });

  it('handles CRLF line endings', () => {
    const robots = parseRobotsTxt('User-agent: *\r\nDisallow: /x\r\n');
    expect(robots.groups).toHaveLength(1);
  });

  it('is case-insensitive on field names and agent tokens', () => {
    const robots = parseRobotsTxt('USER-AGENT: MokaAI-Crawler\nDISALLOW: /x\n');
    expect(robots.groups[0]!.agents).toEqual(['mokaai-crawler']);
  });

  it('collects sitemaps without ending a group', () => {
    const robots = parseRobotsTxt(`
User-agent: *
Sitemap: https://example.com/sitemap.xml
Disallow: /x
`);
    expect(robots.sitemaps).toEqual(['https://example.com/sitemap.xml']);
    expect(robots.groups).toHaveLength(1);
  });

  it('reports an empty file as empty', () => {
    expect(parseRobotsTxt('').empty).toBe(true);
    expect(parseRobotsTxt('# nothing but a comment').empty).toBe(true);
  });

  it('skips lines it cannot parse rather than abandoning the file', () => {
    // One typo must not make us treat a restrictive file as absent.
    const robots = parseRobotsTxt(`
User-agent: *
this line has no colon
Disallow: /admin
`);
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/admin')).toBe(false);
  });
});

describe('allow and disallow', () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /admin
Allow: /admin/public
Disallow: /tmp
`);

  it('blocks a disallowed prefix', () => {
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/admin')).toBe(false);
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/admin/users')).toBe(false);
  });

  it('permits a longer Allow inside a disallowed prefix', () => {
    // Longest match wins. Getting this backwards would refuse pages the site
    // explicitly invited us to read.
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/admin/public/notice')).toBe(true);
  });

  it('permits anything not mentioned', () => {
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/about')).toBe(true);
  });

  it('gives Allow the win on an exact-length tie', () => {
    const tied = parseRobotsTxt('User-agent: *\nDisallow: /x\nAllow: /x\n');
    expect(isPathAllowed(tied, CRAWLER_TOKEN, '/x')).toBe(true);
  });

  it('treats an EMPTY Disallow as permitting everything', () => {
    // The conventional way to write "no restrictions". Recorded as a
    // zero-length rule it would match every path and block the whole site.
    const open = parseRobotsTxt('User-agent: *\nDisallow:\n');
    expect(isPathAllowed(open, CRAWLER_TOKEN, '/anything')).toBe(true);
  });

  it('blocks the whole site for `Disallow: /`', () => {
    const closed = parseRobotsTxt('User-agent: *\nDisallow: /\n');
    expect(isPathAllowed(closed, CRAWLER_TOKEN, '/')).toBe(false);
    expect(isPathAllowed(closed, CRAWLER_TOKEN, '/anything/at/all')).toBe(false);
  });

  it('permits everything when there is no robots.txt', () => {
    expect(isPathAllowed(parseRobotsTxt(''), CRAWLER_TOKEN, '/anything')).toBe(true);
  });

  it('normalises a path with no leading slash', () => {
    const closed = parseRobotsTxt('User-agent: *\nDisallow: /x\n');
    expect(isPathAllowed(closed, CRAWLER_TOKEN, 'x')).toBe(false);
  });
});

describe('agent group selection', () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /

User-agent: mokaai-crawler
Disallow: /private
`);

  it('prefers the group naming us over the wildcard', () => {
    // The wildcard blocks everything; our named group blocks only /private.
    // Picking the wildcard would make a site that welcomed us unreadable.
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/about')).toBe(true);
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/private')).toBe(false);
  });

  it('applies the wildcard to an agent with no group of its own', () => {
    expect(isPathAllowed(robots, 'someoneelse', '/about')).toBe(false);
  });

  it('prefers the longest matching agent token', () => {
    const specific = parseRobotsTxt(`
User-agent: moka
Disallow: /

User-agent: mokaai-crawler
Disallow: /private
`);
    expect(isPathAllowed(specific, CRAWLER_TOKEN, '/about')).toBe(true);
  });

  it('returns null when nothing matches and no wildcard exists', () => {
    const narrow = parseRobotsTxt('User-agent: googlebot\nDisallow: /\n');
    expect(groupFor(narrow, CRAWLER_TOKEN)).toBeNull();
    expect(isPathAllowed(narrow, CRAWLER_TOKEN, '/anything')).toBe(true);
  });
});

describe('wildcards', () => {
  it('matches * as any run of characters', () => {
    expect(matchesPattern('/a*b', '/axxxb')).toBe(true);
    expect(matchesPattern('/a*b', '/ab')).toBe(true);
    expect(matchesPattern('/a*b', '/axxx')).toBe(false);
  });

  it('anchors with $', () => {
    expect(matchesPattern('/x$', '/x')).toBe(true);
    expect(matchesPattern('/x$', '/xy')).toBe(false);
  });

  it('combines both', () => {
    expect(matchesPattern('/*.pdf$', '/docs/report.pdf')).toBe(true);
    expect(matchesPattern('/*.pdf$', '/docs/report.pdf.html')).toBe(false);
  });

  it('ESCAPES regex metacharacters in the pattern', () => {
    /*
     * The pattern is attacker-controlled text from a third-party site. An
     * unescaped `.` would silently widen a rule; an unescaped `(` would throw
     * and, unhandled, take down a crawl.
     */
    expect(matchesPattern('/a.b', '/axb')).toBe(false);
    expect(matchesPattern('/a.b', '/a.b')).toBe(true);
    expect(matchesPattern('/a+b', '/aab')).toBe(false);
    expect(matchesPattern('/a+b', '/a+b')).toBe(true);
  });

  it('does not throw on a pattern that cannot compile', () => {
    expect(() => matchesPattern('/[', '/anything')).not.toThrow();
    expect(matchesPattern('/[', '/anything')).toBe(false);
  });

  it('applies wildcard rules through isPathAllowed', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /*?sessionid=\n');
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/page?sessionid=abc')).toBe(false);
    expect(isPathAllowed(robots, CRAWLER_TOKEN, '/page')).toBe(true);
  });
});

describe('crawl delay', () => {
  it('is read when present', () => {
    const robots = parseRobotsTxt('User-agent: *\nCrawl-delay: 2.5\nDisallow: /x\n');
    expect(crawlDelayFor(robots, CRAWLER_TOKEN)).toBe(2.5);
  });

  it('is null when absent', () => {
    expect(crawlDelayFor(parseRobotsTxt('User-agent: *\nDisallow: /x\n'), CRAWLER_TOKEN)).toBeNull();
  });

  it('is capped, so one site cannot stall a crawl indefinitely', () => {
    const robots = parseRobotsTxt('User-agent: *\nCrawl-delay: 86400\nDisallow: /x\n');
    expect(crawlDelayFor(robots, CRAWLER_TOKEN)).toBe(300);
  });

  it('ignores a nonsensical value', () => {
    const robots = parseRobotsTxt('User-agent: *\nCrawl-delay: soon\nDisallow: /x\n');
    expect(crawlDelayFor(robots, CRAWLER_TOKEN)).toBeNull();
  });
});

describe('fetch failure policy (RFC 9309 §2.3.1)', () => {
  it('permits when the file genuinely does not exist', () => {
    expect(robotsFetchFailurePolicy(404)).toBe('allow');
    expect(robotsFetchFailurePolicy(410)).toBe('allow');
  });

  it('REFUSES when the server would not show us its rules', () => {
    // A 403 on robots.txt is not an invitation to guess.
    expect(robotsFetchFailurePolicy(401)).toBe('deny');
    expect(robotsFetchFailurePolicy(403)).toBe('deny');
  });

  it('REFUSES on server error or network failure rather than crawling blind', () => {
    expect(robotsFetchFailurePolicy(500)).toBe('deny');
    expect(robotsFetchFailurePolicy(503)).toBe('deny');
    expect(robotsFetchFailurePolicy('network_error')).toBe('deny');
  });
});

describe('the user agent we present', () => {
  it('identifies the software and offers a contact path', () => {
    // So a site owner can block us specifically rather than blocking every
    // unknown client. Impersonating a browser would be a small deception with
    // no upside.
    expect(CRAWLER_USER_AGENT).toContain('MokaAI-Crawler');
    expect(CRAWLER_USER_AGENT).toMatch(/https?:\/\//);
    expect(CRAWLER_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|Gecko/);
  });

  it('is addressable by the token we match on', () => {
    expect(CRAWLER_USER_AGENT.toLowerCase()).toContain(CRAWLER_TOKEN);
  });
});
