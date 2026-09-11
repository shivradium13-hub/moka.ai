/**
 * Origin check for state-changing requests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS REPLACES, AND WHY SOMETHING HAD TO
 *
 * `SameSite=lax` blocks CSRF by refusing to send the session cookie on
 * cross-site subresource requests. It is the default and it is the better
 * defence — but it cannot be used when the app and the API sit on different
 * registrable domains (`myapp.vercel.app` talking to `myapi.up.railway.app`),
 * because then the browser sends the cookie on nothing at all and every
 * authenticated request fails. Such a deployment has to set
 * `COOKIE_SAMESITE=none`, which gives the SameSite protection up.
 *
 * CORS does not fill the gap. CORS governs whether a caller may READ a
 * response; it does not prevent the request from executing. A "simple"
 * cross-site request — an HTML form POST, or a GET — is dispatched with
 * credentials, runs on the server, and only the response is withheld from the
 * attacker. For anything that writes, that is already too late.
 *
 * So a mutating request must carry an `Origin` this deployment allows.
 * Browsers attach `Origin` to every cross-site request and script cannot
 * remove or forge it, which is what makes the check worth anything.
 *
 * Pure, so the policy can be tested exhaustively rather than inferred from a
 * hook. `main.ts` supplies the request and acts on the verdict.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Methods that can change state. Everything else is waved through. */
const MUTATING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const OriginVerdict = {
  /** Not a state-changing request, so CSRF does not apply. */
  SAFE_METHOD: 'safe_method',
  /** The public chatbot surface, which carries no ambient authority. */
  PUBLIC_SURFACE: 'public_surface',
  /** No Origin header: not a browser, so no cookie jar to ride on. */
  NO_ORIGIN: 'no_origin',
  ALLOWED: 'allowed',
  REFUSED: 'refused',
} as const;

export type OriginVerdict = (typeof OriginVerdict)[keyof typeof OriginVerdict];

export interface OriginCheckRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly origin: string | undefined;
  readonly allowedOrigins: readonly string[];
}

export function checkOrigin(request: OriginCheckRequest): OriginVerdict {
  const method = (request.method ?? '').toUpperCase();
  if (!MUTATING.has(method)) return OriginVerdict.SAFE_METHOD;

  /*
   * The public chatbot surface is exempt, and this is not an oversight.
   *
   * It is called from customer websites we cannot enumerate, and it carries NO
   * ambient authority: the visitor token travels in a header, not a cookie, so
   * there is no credential for a forged cross-site request to ride on. CSRF is
   * an attack on ambient authority; where there is none, the check protects
   * nothing and would only break every legitimate embed.
   */
  const url = request.url ?? '';
  if (url.startsWith('/public/')) return OriginVerdict.PUBLIC_SURFACE;

  /*
   * No Origin means no browser — curl, a mobile client, a server-to-server
   * call. None of those carry the user's cookie jar, so none of them is the
   * threat this check exists for. Refusing them would break every non-browser
   * caller in order to defend against something that cannot happen.
   *
   * This is the deliberate limit of the control: it defends browser sessions,
   * which is exactly the thing `SameSite` was defending.
   */
  const origin = request.origin;
  if (typeof origin !== 'string' || origin.length === 0) return OriginVerdict.NO_ORIGIN;

  /*
   * Exact string match against the configured allowlist. Not a prefix, not a
   * suffix, not a regex: `https://app.example.com.evil.com` ends with nothing
   * useful and starts with something plausible, and both sloppy comparisons
   * would accept it.
   */
  return request.allowedOrigins.includes(origin) ? OriginVerdict.ALLOWED : OriginVerdict.REFUSED;
}
