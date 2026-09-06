import { Injectable } from '@nestjs/common';
import { loadConfig } from '@moka/config';
import type { ProviderCredential } from '@moka/ai';
import type { TenantContext } from '@moka/core';

/**
 * Provider credential resolution.
 *
 * PHASE 3 SCOPE: credentials come from environment variables, shared by every
 * organization on the instance. That is a single-tenant deployment model and
 * is stated as such rather than dressed up.
 *
 * PHASE 4 replaces this with Moka Credentials: per-organization, envelope-
 * encrypted, BYOK. The interface is already shaped for it — `resolve()` takes
 * a TenantContext it does not yet need, so the vault implementation drops in
 * without touching any caller.
 *
 * The returned secret is handed straight to a per-request adapter and is never
 * cached, logged, or attached to an error.
 */
@Injectable()
export class CredentialsService {
  /** Providers this instance can currently reach. */
  availableProviders(_context: TenantContext): string[] {
    const config = loadConfig();
    const providers: string[] = [];
    if (config.ANTHROPIC_API_KEY) providers.push('anthropic');
    if (config.OPENAI_API_KEY) providers.push('openai');
    return providers;
  }

  /**
   * Resolve a credential, or null when none is configured.
   *
   * Returning null rather than throwing lets the router treat "no credential"
   * as a routing constraint — it plans around an unusable provider instead of
   * selecting it and failing at call time.
   */
  resolve(_context: TenantContext, providerId: string): ProviderCredential | null {
    const config = loadConfig();

    switch (providerId) {
      case 'anthropic':
        return config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : null;
      case 'openai':
        return config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : null;
      default:
        return null;
    }
  }
}
