# MOKA AI — Security Architecture

> **Status:** Phase 0 (design). Nothing here is implemented yet.
> Everything in this document is a requirement on the build, not a description of current state.

---

## 1. Threat model

MOKA AI is a multi-tenant platform where a language model, influenced by untrusted text, can invoke tools that touch customer data. That combination defines the threat model.

| # | Threat | Impact | Primary control |
|---|---|---|---|
| T1 | Tenant A reads or writes Tenant B data | Catastrophic | RLS + derived tenant context (§2) |
| T2 | Provider or customer credential leaks | Catastrophic | Envelope encryption + redaction (§3) |
| T3 | Prompt injection drives an unauthorized tool call | Catastrophic | Untrusted-content isolation + config-time allowlists + approval gates (§4) |
| T4 | SSRF via crawler, research, browser agent or MCP | Severe | Single guarded egress point (§5) |
| T5 | Arbitrary code execution escaping the sandbox | Catastrophic | Container isolation on a Linux host; **not shippable on Windows Home** (§6) |
| T6 | Privilege escalation within an organization | Severe | RBAC evaluated server-side only (§7) |
| T7 | API key abuse or scope escalation | Severe | Hashed keys, scopes, rate limits (§8) |
| T8 | Data exfiltration through model output or tool arguments | Severe | Egress allowlist + output validation (§4.4) |
| T9 | Knowledge base cross-tenant bleed through retrieval | Catastrophic | Mandatory org filter + RLS on chunk and embedding tables (§2.4) |
| T10 | Secrets appearing in logs, traces or error responses | Severe | Logger-level redaction (§3.4) |

---

## 2. Tenant isolation (§5, §37)

### 2.1 Tenant context is derived, never received

```ts
// The ONLY legitimate source of tenant identity.
interface TenantContext {
  organizationId: string;   // from session or API key record
  userId: string | null;    // null for API-key requests
  role: Role;
  scopes: Scope[];
}
```

An `organization_id` (or `tenant_id`, or `org`) arriving in a request body, query string, header or path is **ignored**, and its presence is recorded as a security event with the request ID. It is never used to select or filter data, not even when it happens to match the authenticated organization.

### 2.2 Row-Level Security is the backstop

Every tenant-owned table carries `organization_id uuid NOT NULL` and:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON <table>
  USING      (organization_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.current_org_id', true)::uuid);
```

- The application connects as **`moka_app`**, a non-superuser role with no `BYPASSRLS`.
- Migrations run as a separate, more privileged role that the application process never holds.
- Every transaction opens with `SET LOCAL app.current_org_id = $1`, set from `TenantContext` by a single interceptor. `SET LOCAL` scopes the value to the transaction, so it cannot leak across pooled connections.
- If `app.current_org_id` is unset, the policy matches nothing. **The system fails closed.**

This is the control that matters most: a query that forgets its `WHERE organization_id` clause returns zero rows instead of leaking. Application correctness is no longer the last line of defence.

### 2.3 Connection pooling caveat

`SET LOCAL` is transaction-scoped, so it is safe with a transaction-mode pooler. Any code path that runs outside an explicit transaction must not touch tenant tables. This is enforced by a scoped repository wrapper — raw pool access is not exported from `packages/db`.

### 2.4 Retrieval isolation

`knowledge_chunks` and `knowledge_embeddings` are both RLS-protected. Vector search additionally applies an explicit `organization_id` predicate before the ANN operator, so the filter also shapes the query plan rather than relying on RLS alone. Retrieval results carry their `organization_id` through to the citation layer, where a final assertion rejects any chunk whose organization does not match the request context.

---

## 3. Secrets and Moka Credentials (§4)

### 3.1 Envelope encryption

```
ENCRYPTION_KEY (root KEK, 32 bytes, from env; OpenBao in Phase 10)
   └─ wraps ─▶ per-organization DEK (generated at org creation, stored wrapped)
                  └─ encrypts ─▶ individual credential ciphertexts
```

- Algorithm: **AES-256-GCM**, unique random IV per record.
- **AAD binds the ciphertext to `(organization_id, credential_id, provider)`.** A ciphertext copied into another organization's row, or another credential's row, fails authentication and cannot be decrypted. This defeats database-level tampering, not just theft.
- Key rotation re-wraps DEKs without re-encrypting every credential.

### 3.2 Storage rules

| Rule | Enforcement |
|---|---|
| Never stored plaintext | Encryption at the repository boundary; the column type is ciphertext only |
| Never returned to the frontend | The ciphertext column is excluded from every default select; a dedicated, audited method is the only reader |
| Never in logs | Logger-level redaction (§3.4) |
| Never in AI prompts | The prompt assembler receives a credential *handle*, never a value |
| Never in error messages | Normalized error taxonomy; provider errors are re-mapped before they leave the gateway |

For display, only a non-reversible fingerprint and the last four characters are stored, in separate plain columns.

### 3.3 Credential lifecycle

`add → test → enable/disable → rotate → revoke`, each producing an audit record. Testing a credential performs a minimal authenticated call to the provider and stores only the outcome, never the response body. Revocation is immediate and takes effect on in-flight requests at the next gateway resolution.

### 3.4 Redaction

Redaction is configured on the **logger and error serializers**, not applied at call sites. A call site cannot opt out. Patterns cover known key shapes (`sk-`, `AIza`, bearer tokens, JWTs), any field named like a secret (`*key*`, `*token*`, `*secret*`, `*password*`, `authorization`, `cookie`), and the ciphertext columns themselves.

### 3.5 BYOK

Bring-Your-Own-Key credentials use the identical vault and the identical rules. A BYOK credential is scoped to its organization and can never be selected by the router for another organization's request. MOKA AI claims no ownership of third-party models or APIs, and never bypasses provider authentication, licensing or terms.

---

## 4. AI-specific security (§37)

### 4.1 The governing rule

**Retrieved content and tool output are data. They are never instructions.**

This applies to knowledge chunks, crawled pages, uploaded documents, web research results, MCP tool responses, browser page text, and end-user messages in a customer-facing chatbot. Nothing in that content can:

- add, remove or widen a tool allowlist,
- change permission or risk levels,
- select or reveal a credential,
- alter an approval requirement,
- redirect an outbound request to a new recipient or endpoint,
- modify the agent's own instructions.

### 4.2 Structural defences

1. **Config-time binding.** An agent's tools, permissions and knowledge scope are fixed in its stored configuration. The runtime reads them from the database on every run. There is no code path by which model output modifies them.
2. **Delimited untrusted blocks.** Untrusted content is wrapped in explicit markers with a standing system rule that content inside is reference material only. Delimiters found *within* untrusted content are escaped so it cannot close its own block.
3. **Approval gates are non-negotiable.** An EXECUTE-risk action requires human approval regardless of what any content claims about authorization, urgency, testing mode or prior sessions.
4. **Provenance labelling.** Every context block is tagged with its path (customer knowledge / live business data / external web) and carries that label into the answer.

### 4.3 Tool-call authorization

Each call is checked server-side, in order, and any failure aborts the run:

```
schema validation → permission level → risk gate → tenant scope injection
  → rate/budget check → execute → output validation → audit
```

Tenant scope is **injected server-side from `TenantContext`**. Tool schemas do not accept an `organization_id` argument at all, so the model has no way to express a cross-tenant request.

### 4.4 Exfiltration controls

- Outbound network access from tools is restricted to an allowlist.
- Tool arguments that carry free-form destinations (URLs, email recipients, webhook targets) are validated against that allowlist and, for anything user-visible, require approval.
- Model output is scanned for credential-shaped strings before it is persisted or returned.

### 4.5 Customer-facing chatbot boundary (§23)

**Implemented in Phase 6.** Security suite 8 (`tests/security/customer-boundary.test.ts`).

A public chatbot must never expose other customers' data, internal admin data, secrets, system prompts, or unrestricted database content.

#### The principal

A chatbot visitor is **not a user with a low role — they hold no role at all**. `CustomerContext` (in `@moka/core`) has no field from which a permission can be derived, so `hasPermission` is not merely uncalled on that path, it does not typecheck.

The shortcut this refuses is modelling a visitor as `role: 'viewer'`. A viewer holds `project:read`, `organization:read` and `member:read`, so that one line would hand every passer-by on a customer's marketing site the ability to list the organization's projects and members — and the four-gate authoriser would permit it, correctly, having been told the caller was a viewer.

`authorizeToolCall` therefore branches on a `Principal` union. On the customer branch there is no RBAC check because there is nothing to check with; instead a tool must satisfy three conditions, each of which **defaults to refusing**:

| Condition | Why it is separate |
|---|---|
| `customerSafe === true` | Opt-in. A tool added to the platform is unreachable by the public until an author writes the flag and a reviewer sees it in a diff. |
| `risk === READ` | Re-derives publishability from what the tool *does*, rather than trusting the annotation. Catches a mis-declared registry entry at call time. |
| not approval-gated | An approval requested by an anonymous stranger is a denial of service against human attention, and the deciding member has no way to judge who asked. |

#### Resolution order

    public key   → deployment      (narrow RLS policy, no organization bound)
    deployment   → organization    (from the row, never from the request)
    visitor token + organization → conversation
    conversation → CustomerContext, carrying no role

Each step is scoped by the previous one, so presenting tenant A's key with tenant B's visitor token **finds nothing** rather than finding something and then rejecting it.

The deployment lookup is the one place a tenant table is readable with no organization bound. It uses the same shape as `0002_user_scope.sql`: a narrow policy keyed on `app.current_deployment_key`, guarded by `current_org_id() IS NULL` so it is unreachable from inside any tenant-scoped transaction. `WITH CHECK` is not widened — the public path may read one row and write nothing.

#### Two kinds of key

| | Deployment key | Visitor token |
|---|---|---|
| Where it lives | The customer's page source | One browser's `sessionStorage` |
| Secret? | **No.** Public by design. | **Yes**, for one conversation. |
| Stored | Plaintext | SHA-256 hash, like a session token |
| Grants | A fresh, empty conversation — what any visitor already has | Read and continue exactly one conversation, until it expires |

#### The publication boundary

`chatbot_sources` is the only knowledge a chatbot may quote, and retrieval on the public path goes through `searchWithinSources`, which **returns nothing for an empty allowlist**. The convention in `search()` that an empty `sourceIds` means "no restriction" is correct for a staff caller and is a leak on the public path; the two entry points exist so that difference cannot be got wrong by omission.

The scope is a **closure, not a tool argument**. The model cannot widen it because there is no parameter naming it.

#### Grounding

Enforced **after** the run, against what retrieval actually returned — not against the model's account of itself. If nothing was retrieved and the chatbot requires grounding, the answer is discarded and replaced with a refusal however confident it was. Citations are likewise derived from what was retrieved; a model-supplied source list is plausible, not true, and a fabricated citation turns an unsupported answer into an apparently sourced one.

#### Origin allowlist: two jobs, very different strength

| Use | Strength |
|---|---|
| `frame-ancestors` on the chat frame | **Strong.** Enforced by the visitor's own browser; a third-party site cannot forge past it. |
| Compared against the `Origin` header on API calls | **Weak.** `Origin` is browser-set and simply absent from `curl`. Stops casual reuse of a deployment on an unrelated site, and nothing more. |

Conflating the two is the mistake to avoid. The security of the public surface rests on the role-less principal and the read-only, closure-scoped tool set — not on this list.

#### Rendering

The chat UI runs in a **cross-origin iframe on our origin**, not injected into the customer's DOM. Model output influenced by documents we did not write must never be rendered inside a customer's own origin, where an escaping mistake would become XSS on their site with their cookies. Inside the frame every message is placed with `textContent`; there is no `innerHTML`, no Markdown renderer, and the frame's CSP is `default-src 'none'` with `script-src 'self'` and a per-response style nonce.

#### Known limitation

Order lookup and similar personal queries — which would require the *end customer* to be authenticated, with authorization checked against that authenticated identity rather than an identifier supplied in the conversation — are **not implemented**. No customer-authentication mechanism exists yet, and no tool on the public path can read a personal record. That arrives with the business agents in Phase 7.

#### Cross-tenant references and RLS

PostgreSQL performs referential integrity checks **with row security disabled**. That is documented and deliberate: otherwise a foreign key would leak the existence of invisible rows through constraint violations. But it means a single-column `REFERENCES parent(id)` is satisfied by any row in the installation, visible or not, and an RLS policy that only checks the *child* row's `organization_id` will happily store a cross-tenant pointer.

Suite 8 found exactly that on `chatbot_sources`. `0010_chat_tenant_integrity.sql` fixes it by carrying `organization_id` into the key itself: a composite `FOREIGN KEY (organization_id, source_id)` makes "the parent belongs to the same tenant" a referential constraint rather than a policy, which holds in the one place policies do not apply.

**Known item:** the same shape exists on some earlier joins, `agent_tools.agent_id` among them. None leaks today — the referenced data is itself RLS-protected and the application layer checks ownership — but "two independent controls happen to save us" is not "this cannot happen". Converting the Phase 1–5 joins belongs in its own reviewed change rather than being folded into this phase.

### 4.6 Citation integrity (§9, §45)

**Implemented in Phase 7.** The gate: *no fabricated citations.*

The failure mode is specific and well documented. Ask a model to research something and cite its sources, and it will produce a bibliography — plausible titles, plausible authors, URLs that resolve to nothing or to something else entirely. It is not lying; it is completing a pattern. And a fabricated citation is worse than no citation, because it converts an unsupported claim into an apparently sourced one, which is exactly the form people stop checking.

**So the model is never given the chance.** It does not write URLs. It writes `[3]`.

#### The ledger

Every URL in a finished answer comes from a record of documents the system actually fetched: the final URL **after redirects**, the fetch time, a SHA-256 of the bytes, and the exact excerpt placed in the prompt. Ids are assigned in fetch order and are the only handle a model is given. A citation is a lookup, not a generation.

What the model is shown is `[1] Pricing — example.com`: a number, a title and a **host**. Not the URL. The host is what it needs to weigh credibility — the vendor's own documentation versus a forum post — and is not enough to reconstruct a citable link. Putting the full URL in the prompt would place the exact string we are trying to keep it from producing directly into its context.

#### Verification, after the fact

`verifyAnswer` runs on what the model actually said, in the same spirit as Phase 6's grounding check:

| Check | Action |
|---|---|
| A `[n]` naming no ledger entry | **Removed** and reported. Leaving it shows a reader a citation for a claim that has none. |
| An absolute URL appearing in no fetched excerpt | **Removed** and reported. A model quoting a link out of a page it read is reporting; one producing a link from training data is the failure being guarded against. |
| A quoted span absent from the source it cites | **Flagged**, not deleted. Models paraphrase inside quotation marks often enough that deleting on a miss would mangle honest answers. |
| No valid citation at all | Reported as `unsupported`. Sometimes legitimate ("I could not find anything on this"), so the caller decides. |

#### The refusal that matters most

When nothing could be collected, **the model is not called at all**. Handing a model a question, an instruction to cite everything, and nothing to cite is the single most reliable way to produce an invented bibliography. Refusing costs one provider call and saves a fabrication. The same applies when search itself fails: there is deliberately no fallback to "answer anyway", because an answer produced with no search is an answer from training data wearing a research feature's clothes.

#### Auditable afterwards

`research_sources` persists the ledger, including the excerpt. Six months later anyone can open a run and see the URL that was fetched, when, a hash of what came back, and the exact text in front of the model when it wrote a given sentence. That turns "the system does not fabricate sources" from an assertion about code into something a person can verify from a row.

Candidates that were **not** collected are stored too, with the reason. An answer that used two sources out of nine is a different answer from one that had two candidates, and the reader deserves to be able to tell.

Both the verified answer and the **raw** one are kept. If the system silently corrected an answer, the person relying on it should be able to see what was corrected; storing only the tidied version would hide our own edits from the only people who would want to review them.

#### What this does not claim

None of it makes the prose true. It makes every source attached to the prose real, which is a smaller claim and an honest one. A model can still misread a page it genuinely fetched.

---

## 5. SSRF defence and egress policy (§14, §29, §30)

**Security suite 6** (`tests/security/ssrf.test.ts`) — the Phase 7 gate.

All outbound HTTP from the crawler, research pipeline and any tool goes through **one** function, `safeFetch`, in `packages/net`. Direct use of `fetch`/`axios` outside that package is blocked by a lint rule.

`safeFetch` enforces:

1. Scheme allowlist: `http`, `https` only.
2. **Address classification at connect time**, via a custom `lookup` on the undici agent, with the resolved IP checked against blocked ranges:
   - loopback `127.0.0.0/8`, `::1`
   - private `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`
   - link-local `169.254.0.0/16`, `fe80::/10` — including **`169.254.169.254`** (cloud metadata)
   - CGNAT `100.64.0.0/10`
   - unspecified, multicast, reserved
   - IPv4-mapped IPv6 forms of all of the above (`::ffff:127.0.0.1`)
3. **Re-validation after every redirect.** Redirects are followed manually for this reason; undici's automatic following would bypass the per-hop check.
4. Only the addresses that PASSED are handed back to the socket, so a name resolving to both a public and a private address never falls back to the private one. This is where DNS rebinding is actually defeated: there is no window between check and connect.
5. Blocked ports for high-value internal services (databases, caches, container control planes).
6. Response size cap and hard timeout.
7. Optional per-request host allowlist.

### What suite 6 tests that the unit tests do not

`packages/net` already tests `safeFetch` in isolation. Suite 6 tests something different and historically more likely to be wrong: that the **features** which make outbound requests actually go through it, and that the guard still holds when reached the way an attacker would reach it — through a research URL, a crawl seed, or a redirect from a page we were legitimately reading.

A guard that is correct and bypassed is not a guard. Most SSRF incidents are not a broken IP check; they are a second code path that forgot to call it.

The suite assumes the attacker can put any URL into a research request or a crawl seed, controls a web server our crawler will read, and can make that server redirect anywhere and resolve DNS to anything.

### robots.txt is an egress control, not a courtesy

`packages/net/robots.ts` implements RFC 9309: group matching on `User-agent`, `Allow`/`Disallow` with longest-match-wins and Allow winning ties, `*` and `$` wildcards, plus `Crawl-delay` and `Sitemap`.

It lives next to `safeFetch` because the two answer the same kind of question. SSRF rules decide *which addresses* we may dial; robots rules decide *which paths we are permitted to*. The brief forbids bypassing a provider's terms, and a site's robots.txt is the machine-readable form of its terms for automated clients.

The failure policy is the part worth stating (RFC 9309 §2.3.1):

| robots.txt fetch | Decision |
|---|---|
| 404 / 410 | **Allow.** The site has no robots.txt and has restricted nothing. |
| 401 / 403 | **Deny.** A server that will not show us its rules has not invited us to guess them. |
| 5xx / network error | **Deny.** Crawling blind because we could not read the rules is the cautious reading in reverse. |

Pattern matching escapes regex metacharacters before compiling: a robots pattern is attacker-controlled text from a third-party site, and an unescaped `.` silently widens a rule while an unescaped `(` throws.

The crawler additionally honours `<meta name="robots" content="noindex">` by reading a page and **not storing it**, and per-link `rel="nofollow"`. It presents an honest user agent (`MokaAI-Crawler/1.0 (+https://moka.ai/bot)`) so a site owner can block us specifically; impersonating a browser would be a small deception with no upside and would defeat the token we ask sites to match on.

### The one legitimate private-address exception

`configuredInternalHosts` permits named hosts to resolve to private addresses. It exists because a self-hosted SearXNG usually is on one, and the distinction that makes it safe is the **source of the value, not its shape**:

- A URL derived from a **request** — a crawl target, a page a model asked for — is attacker-influenceable and never gets this. That is the entire SSRF threat, and nothing in the codebase passes such a value here.
- A URL from validated **boot configuration** is chosen by the person running the server, who could equally point `DATABASE_URL` at an internal host. Refusing it would not add safety; it would push operators to disable the guard wholesale, which is strictly worse.

It remains an allowlist of exact hostnames: every other address stays blocked on the same request, and a redirect cannot walk from the permitted host into another private one. Suite 6 asserts both.

`testOnlyAllowPrivateHosts` is a separate, narrower hatch that throws in production. It exists so the transport path can be exercised against a local server.

### Attribution of refusals

An SSRF refusal is never reported as a robots decision. The robots check fetches `robots.txt`, so an internal address fails there first — and reporting "their robots.txt disallows it" about `169.254.169.254` would be a false statement about a publisher that does not exist, while hiding the real cause from the operator reading the result. The error propagates and is re-classified by the caller.

User-facing detail is deliberately coarse in both cases. A caller who can tell "blocked because private" from "blocked because it did not resolve" has a working internal port scanner.

---

## 6. Sandbox (§27, §28)

Requirements for the coding agent's execution environment: CPU limit, memory limit, wall-clock timeout, filesystem isolation, network restriction (default deny), process count limit, ephemeral workspace, automatic cleanup, and **no access to production secrets, the application database, or the credential vault**.

> **Blocking constraint.** The current machine is Windows 11 Home with no Hyper-V, no WSL2 and no Docker. Genuine isolation for AI-generated code cannot be provided here. Per §45, we will **not** ship a stub that pretends to sandbox. Phase 8 targets a remote Linux runner; until one exists, the coding agent and sandbox stay explicitly marked TODO and disabled.

Arbitrary AI-generated commands are never executed against production infrastructure under any configuration.

---

## 7. AuthN / AuthZ (§20, §37)

- Sessions: httpOnly, Secure, SameSite cookies; server-side session records; rotation on privilege change.
- Passwords: Argon2id.
- RBAC evaluated **server-side only**. UI permission state is presentation, never enforcement.
- Roles are organization-scoped; a user in two organizations holds two independent role assignments.
- Permission levels for tools: **READ**, **DRAFT**, **EXECUTE**.
- High-risk operations — delete, refund, price change, publish, account changes, financial actions — require the approval flow in §21 even for an owner-role user.

---

## 8. API platform security (§33)

- API keys are stored as a hash (Argon2id); the plaintext is shown exactly once at creation.
- Keys carry explicit scopes and an organization binding; a key can never widen its own scope.
- Per-key and per-organization rate limits, backed by Valkey.
- Every API request is audited with request ID, key ID, route, outcome and latency.
- Key revocation is immediate.
- The embeddable widget uses a **public, domain-restricted, non-secret** identifier. No API key is ever present in browser-delivered code.

---

## 9. Platform hardening (§37, §38)

- Input validation with Zod at every boundary; output validation on tool results and provider responses.
- Parameterised queries throughout (Drizzle); no string-concatenated SQL.
- Security headers: HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy`, frame ancestors restricted (with a deliberate exception for the widget's embedding domains).
- CSRF protection on cookie-authenticated state-changing routes; API-key routes are exempt by design since they do not use ambient credentials.
- Rate limiting per IP, per user, per organization, per API key.
- Upload validation: content-type sniffing rather than trusting the extension, size caps, and malware scanning via ClamAV (GPL, self-hosted) where available.
- No stack traces in production responses. Errors return a code, a user-safe message and a request ID; the detail stays in structured logs.
- No unhandled promise rejections — a global handler logs and exits rather than continuing in an unknown state.

---

## 10. Mandatory security test suites (§39)

These live in `tests/security/` and run against real PostgreSQL and Valkey in CI. A failure blocks the build. Each is written to **fail closed** — a test that cannot establish its preconditions fails rather than skips.

| # | Suite | Core assertion |
|---|---|---|
| 1 | Tenant isolation | Tenant A cannot read or write any Tenant B row, across every tenant table, including via forged `organization_id` in every request position |
| 2 | Unauthorized tool execution | An agent cannot invoke a tool outside its configured allowlist, and cannot exceed its permission level |
| 3 | Credential exposure | No API response, log line, trace, error or prompt contains a credential value |
| 4 | Privilege escalation | A member cannot assume admin or owner capabilities; a key cannot widen its scopes |
| 5 | Prompt injection | Injected instructions in documents, crawled pages, tool output and user messages fail to alter tool allowlists, permissions, credentials, approval requirements or egress targets |
| 6 | SSRF | Every blocked range is rejected, including after redirect chains and rebinding attempts — asserted through the CRAWLER and RESEARCH features, not only against `safeFetch` itself. Plus robots.txt compliance and the bounds of the configured-internal-host exception |
| 7 | Arbitrary command execution | No path reaches host command execution; sandbox escape attempts fail |
| 8 | Customer boundary | A chatbot visitor holds no role; reaches exactly one conversation in one organization; reads only explicitly published knowledge; and the widget ships no secret |
| 9 | File access isolation | Uploaded files are reachable only within the owning organization; path traversal fails |
| 10 | Knowledge isolation | Retrieval, citation and re-index paths never surface another organization's chunks |

Suite 1 gates Phase 1. Suite 10 gates Phase 2. Suites 2 and 5 gate Phase 5. Suite 8 gates Phase 6. Suite 6 gates Phase 7, alongside the citation-integrity gate in §4.6.

Suite 8 was originally scoped as "API authorization" (scopes, revocation, cross-organization key rejection). Those assertions did not disappear: the public deployment key IS the externally-presented key of this phase, and revocation, cross-organization rejection and rate limiting are all asserted against it. Programmatic API keys for staff integrations arrive with Phase 9.

Every suite is **mutation-tested**: a control is removed, the suite is re-run, and it must fail. A security test that cannot fail is decoration. The records are in `docs/roadmap.md`.

---

## 11. Auditing (§37)

Every security-relevant action writes an immutable `audit_logs` record: actor, organization, action, resource type and ID, before and after values for mutations, request ID, IP, user agent, outcome, timestamp. Audit writes are append-only; the application role holds no `UPDATE` or `DELETE` grant on that table. Reads are organization-scoped like any other tenant data.
