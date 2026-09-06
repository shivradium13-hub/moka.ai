import { lookup as dnsLookup } from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import type { Dispatcher } from 'undici';
import { classifyIp, isBlockedHostname } from './ip-rules.js';
import type { BlockReason } from './ip-rules.js';

/**
 * The single SSRF-guarded egress point (docs/security.md §5).
 *
 * ESLint forbids `fetch`, `axios`, `undici` and friends everywhere except this
 * package, so every outbound request the platform makes on a tenant's behalf
 * passes through here.
 *
 * WHY VALIDATION HAPPENS AT CONNECT TIME
 * The obvious design — resolve the hostname, check the IP, then call fetch —
 * is broken. Between the check and the connection, `fetch` resolves the name
 * again, and an attacker controlling DNS can return a public address for the
 * first lookup and 169.254.169.254 for the second. That is DNS rebinding.
 *
 * Instead the check is installed in the connection path itself, as a custom
 * `lookup` on the undici Agent. Every address the socket is about to connect
 * to is classified first, so there is no window between check and use, and
 * redirects are covered automatically because each hop opens a new connection.
 */

export class SsrfBlockedError extends Error {
  constructor(
    readonly target: string,
    readonly reason: BlockReason | 'scheme' | 'port' | 'hostname' | 'redirect',
  ) {
    // The message is deliberately generic; the detail is for logs, not for a
    // caller who may be probing which internal hosts exist.
    super('Request to this address is not permitted.');
    this.name = 'SsrfBlockedError';
  }
}

export class FetchTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
    this.name = 'FetchTimeoutError';
  }
}

export class ResponseTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Response exceeded ${limitBytes} bytes.`);
    this.name = 'ResponseTooLargeError';
  }
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Whole-request deadline, including redirects. Default 30s. */
  timeoutMs?: number;
  /** Maximum bytes buffered from the response. Default 10 MiB. */
  maxBytes?: number;
  /** Maximum redirects to follow. Default 3; 0 disables redirects. */
  maxRedirects?: number;
  /**
   * When set, only these hostnames are reachable. Used for provider adapters
   * and, later, for per-tenant crawl allowlists.
   */
  allowedHosts?: readonly string[];
  signal?: AbortSignal;
  /**
   * TEST ONLY — explicit private addresses permitted for this one request.
   *
   * Exists so the transport path (redirect re-validation, size caps,
   * timeouts) can be exercised against a local server, which the guard would
   * otherwise correctly refuse. It is an ALLOWLIST, not a switch: every
   * address not named here stays blocked, so a "redirect to the metadata
   * service" test is still a real test.
   *
   * Throws if NODE_ENV is production.
   */
  testOnlyAllowPrivateHosts?: readonly string[];
}

const DEFAULTS = {
  timeoutMs: 30_000,
  maxBytes: 10 * 1024 * 1024,
  maxRedirects: 3,
} as const;

/** Only these schemes are ever fetched. `file:`, `ftp:`, `gopher:` are not. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Ports that are never dialled.
 *
 * Blocking a small set of high-value internal services is worthwhile even
 * though it is not exhaustive: the IP rules are the real control, and this
 * only removes the most attractive targets when a host is legitimately public
 * but multi-tenanted.
 */
const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  22, 23, 25, 110, 143, 445, 465, 587, 993, 995, // remote access and mail
  1433, 1521, 3306, 5432, 6379, 9200, 11211, 27017, // databases and caches
  2375, 2376, 2379, 2380, 10250, // container and cluster control planes
]);

function assertTestHatchPermitted(hosts: readonly string[] | undefined): void {
  if (!hosts || hosts.length === 0) return;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('testOnlyAllowPrivateHosts must never be used in production.');
  }
}

function validateUrl(
  raw: string,
  allowedHosts?: readonly string[],
  privateEscapes?: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(raw, 'scheme');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError(raw, 'scheme');
  }
  const escaped = (privateEscapes ?? []).includes(url.hostname);

  if (!escaped && isBlockedHostname(url.hostname)) {
    throw new SsrfBlockedError(url.hostname, 'hostname');
  }

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new SsrfBlockedError(`${url.hostname}:${port}`, 'port');
  }

  if (allowedHosts && allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const permitted = allowedHosts.some(
      (allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`),
    );
    if (!permitted) throw new SsrfBlockedError(url.hostname, 'hostname');
  }

  // A literal IP in the URL is classified immediately; a name is classified
  // at connect time by the agent below.
  const literal = classifyIp(url.hostname.replace(/^\[|\]$/g, ''));
  if (!escaped && literal.reason !== 'not_an_ip' && !literal.allowed) {
    throw new SsrfBlockedError(url.hostname, literal.reason ?? 'hostname');
  }

  return url;
}

/**
 * An undici Agent whose DNS lookup rejects any address that fails
 * classification. This is where DNS rebinding is actually defeated.
 */
function guardedAgent(privateEscapes?: readonly string[]): Dispatcher {
  return new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        if ((privateEscapes ?? []).includes(hostname)) {
          dnsLookup(hostname, options, callback);
          return;
        }
        dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) {
            callback(error, '', 0);
            return;
          }

          const resolved = Array.isArray(addresses) ? addresses : [addresses];
          const permitted = resolved.filter((entry) => classifyIp(entry.address).allowed);

          if (permitted.length === 0) {
            const first = resolved[0];
            const verdict = first ? classifyIp(first.address) : undefined;
            callback(
              new SsrfBlockedError(hostname, verdict?.reason ?? 'hostname'),
              '',
              0,
            );
            return;
          }

          // Hand back ONLY the addresses that passed. If a name resolves to
          // both a public and a private address, the private one is never
          // dialled rather than being tried as a fallback.
          callback(null, permitted as never);
        });
      },
    },
    connectTimeout: 10_000,
  });
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly url: string;
  readonly body: Uint8Array;
  text(): string;
  json<T>(): T;
}

/**
 * Perform an outbound HTTP request with SSRF, timeout and size protection.
 *
 * Redirects are followed manually so each hop is re-validated against the
 * same rules. `redirect: 'manual'` is essential: undici's automatic redirect
 * following would bypass the per-hop URL checks.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? DEFAULTS.maxRedirects;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const dispatcher = guardedAgent(options.testOnlyAllowPrivateHosts);

  try {
    assertTestHatchPermitted(options.testOnlyAllowPrivateHosts);
    let current = validateUrl(rawUrl, options.allowedHosts, options.testOnlyAllowPrivateHosts);
    let method = options.method ?? 'GET';
    let body = options.body;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await undiciFetch(current.toString(), {
        method,
        headers: options.headers ?? {},
        ...(body !== undefined ? { body: body as never } : {}),
        redirect: 'manual',
        signal: controller.signal,
        dispatcher,
      });

      const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
      if (isRedirect) {
        if (hop === maxRedirects) {
          throw new SsrfBlockedError(current.hostname, 'redirect');
        }
        const location = response.headers.get('location');
        if (!location) break;

        // Re-validate the destination with the full ruleset.
        current = validateUrl(
          new URL(location, current).toString(),
          options.allowedHosts,
          options.testOnlyAllowPrivateHosts,
        );

        // 303, and 301/302 in practice, become GET with no body.
        if (response.status === 303 || response.status === 301 || response.status === 302) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }

      // Enforce the size cap while reading, not after: a caller must not be
      // able to make the process buffer an unbounded response.
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > maxBytes) {
        throw new ResponseTooLargeError(maxBytes);
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          const bytes = chunk as Uint8Array;
          total += bytes.byteLength;
          if (total > maxBytes) throw new ResponseTooLargeError(maxBytes);
          chunks.push(bytes);
        }
      }

      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return {
        status: response.status,
        headers,
        url: current.toString(),
        body: merged,
        text: () => new TextDecoder().decode(merged),
        json: <T,>() => JSON.parse(new TextDecoder().decode(merged)) as T,
      };
    }

    throw new SsrfBlockedError(current.hostname, 'redirect');
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof SsrfBlockedError)) {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    void (dispatcher as Agent).close().catch(() => undefined);
  }
}

export interface AssertSafeUrlOptions {
  allowedHosts?: readonly string[];
  /** TEST ONLY. See SafeFetchOptions.testOnlyAllowPrivateHosts. */
  testOnlyAllowPrivateHosts?: readonly string[];
}

/** Validate a URL without fetching it. Used to vet configured endpoints. */
export function assertSafeUrl(rawUrl: string, options: AssertSafeUrlOptions = {}): void {
  /*
   * Every field of AssertSafeUrlOptions is optional, so an array structurally
   * satisfies the type and TypeScript accepts `assertSafeUrl(url, ['host'])` —
   * which would silently apply NO allowlist. Fail loudly instead of quietly
   * weakening the check.
   */
  if (Array.isArray(options)) {
    throw new TypeError('assertSafeUrl expects an options object, not an array of hosts.');
  }
  assertTestHatchPermitted(options.testOnlyAllowPrivateHosts);
  validateUrl(rawUrl, options.allowedHosts, options.testOnlyAllowPrivateHosts);
}
