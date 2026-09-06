import type { ChatRequest, ChatResponse, StreamEvent } from '../types.js';

/**
 * Provider adapter contract (docs/architecture.md §3).
 *
 * Every adapter is constructed with a credential and an optional base URL,
 * and exposes exactly these two calls. Adding a provider means implementing
 * this interface and registering it — nothing else in the platform changes.
 *
 * SECRET HANDLING: the credential is held only in the adapter instance for
 * the life of one request. It is never logged, never attached to an error,
 * and never returned. Adapters are constructed per request rather than kept
 * in a long-lived map keyed by organization, so a credential cannot outlive
 * its use or be picked up by another tenant's request.
 */

export interface ProviderCredential {
  readonly apiKey: string;
  /**
   * Overrides the provider's default endpoint. Used for self-hosted,
   * proxy, and compatible deployments — and it is user-supplied, so any
   * adapter honouring it MUST validate it with @moka/net first.
   */
  readonly baseUrl?: string;
  /**
   * TEST ONLY — private hosts this adapter may address, so adapters can be
   * tested against a local server speaking the provider wire format.
   * Refused when NODE_ENV is production. Never set from tenant input.
   */
  readonly testOnlyAllowPrivateHosts?: readonly string[];
}

export interface ProviderAdapter {
  readonly providerId: string;
  /** Single-shot completion. */
  chat(request: ChatRequest, modelId: string): Promise<ChatResponse>;
  /** Incremental completion. Errors after first byte arrive as stream events. */
  stream(request: ChatRequest, modelId: string): AsyncIterable<StreamEvent>;
}

export type ProviderFactory = (credential: ProviderCredential) => ProviderAdapter;
