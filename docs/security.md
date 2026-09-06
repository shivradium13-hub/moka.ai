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

A public chatbot must never expose other customers' data, internal admin data, secrets, system prompts, or unrestricted database content. Order lookup and similar personal queries require the end customer to be authenticated, and authorization is checked against the *authenticated customer's* identity, not against an identifier supplied in the conversation.

---

## 5. SSRF defence (§14, §29, §30)

All outbound HTTP from the crawler, research pipeline, browser agent, MCP client and any tool goes through **one** function, `safeFetch`, in `packages/net`. Direct use of `fetch`/`axios` outside that package is blocked by lint rule and reviewed in CI.

`safeFetch` enforces:

1. Scheme allowlist: `http`, `https` only.
2. **DNS resolution before connect**, with the resolved IP checked against blocked ranges:
   - loopback `127.0.0.0/8`, `::1`
   - private `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`
   - link-local `169.254.0.0/16`, `fe80::/10` — including **`169.254.169.254`** (cloud metadata)
   - CGNAT `100.64.0.0/10`
   - unspecified, multicast, reserved
3. **Re-validation after every redirect** (this is where naive implementations fail), with a redirect cap.
4. Pinning the validated IP for the actual connection, closing the DNS-rebinding window between check and connect.
5. Per-domain rate limiting and politeness delay.
6. Response size cap and hard timeout.
7. Optional per-organization domain allowlist, mandatory for the browser agent.
8. No credential or cookie forwarding across origins.

The crawler additionally honours `robots.txt`, applies page and depth limits, deduplicates by canonical URL, and restricts crawling to the domains the organization has verified.

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
| 6 | SSRF | Every blocked range is rejected, including after redirect chains and rebinding attempts, across crawler, research, browser and MCP |
| 7 | Arbitrary command execution | No path reaches host command execution; sandbox escape attempts fail |
| 8 | API authorization | Scope enforcement, revocation, rate limits, and cross-organization key rejection |
| 9 | File access isolation | Uploaded files are reachable only within the owning organization; path traversal fails |
| 10 | Knowledge isolation | Retrieval, citation and re-index paths never surface another organization's chunks |

Suite 1 is the gate on Phase 1. Suite 10 is the gate on Phase 2.

---

## 11. Auditing (§37)

Every security-relevant action writes an immutable `audit_logs` record: actor, organization, action, resource type and ID, before and after values for mutations, request ID, IP, user agent, outcome, timestamp. Audit writes are append-only; the application role holds no `UPDATE` or `DELETE` grant on that table. Reads are organization-scoped like any other tenant data.
