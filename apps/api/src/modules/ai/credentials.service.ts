import { Injectable } from '@nestjs/common';
import { loadConfig } from '@moka/config';
import type { ProviderCredential } from '@moka/ai';
import type { TenantContext } from '@moka/core';
import { VaultService } from './vault.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * Credential resolution for the gateway.
 *
 * Order of precedence, and why:
 *
 *  1. **Moka Credentials vault** — per-organization, envelope-encrypted, BYOK.
 *     This is the real mechanism and always wins.
 *  2. **Environment variables** — a DEVELOPMENT fallback only. They are
 *     instance-wide, so every organization would share one key.
 *
 * The vault takes precedence deliberately. If it were the other way round, an
 * operator's stray `ANTHROPIC_API_KEY` would silently override every tenant's
 * own key and bill all their traffic to the instance owner.
 *
 * In production the fallback is refused outright (see `envFallback`), because
 * sharing one provider key across tenants defeats per-tenant attribution,
 * quota and revocation.
 */
@Injectable()
export class CredentialsService {
  constructor(private readonly vault: VaultService) {}

  /**
   * Environment credentials, if permitted.
   *
   * Returns null in production regardless of what is configured. A shared key
   * is a development convenience, not a deployment mode.
   */
  private envFallback(providerId: string): ProviderCredential | null {
    const config = loadConfig();
    if (config.NODE_ENV === 'production') return null;

    switch (providerId) {
      case 'anthropic':
        return config.ANTHROPIC_API_KEY ? { apiKey: config.ANTHROPIC_API_KEY } : null;
      case 'openai':
        return config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : null;
      case 'google':
        return config.GEMINI_API_KEY ? { apiKey: config.GEMINI_API_KEY } : null;
      default:
        return null;
    }
  }

  private envProviders(): string[] {
    return ['anthropic', 'openai', 'google'].filter(
      (providerId) => this.envFallback(providerId) !== null,
    );
  }

  /** Providers this organization can actually use, vault first. */
  async availableProviders(context: TenantContext): Promise<string[]> {
    const fromVault = await this.vault.availableProviders(context);
    return [...new Set([...fromVault, ...this.envProviders()])];
  }

  /**
   * Resolve a usable credential, or null.
   *
   * Null rather than throwing: the router treats an unusable provider as a
   * routing constraint and plans around it, instead of selecting a model that
   * is guaranteed to fail at call time.
   */
  async resolve(context: TenantContext, providerId: string): Promise<ProviderCredential | null> {
    const fromVault = await this.vault.resolve(context, providerId);
    if (fromVault) return fromVault;

    const fallback = this.envFallback(providerId);
    if (fallback) {
      getLogger().debug(
        { organizationId: context.organizationId, providerId },
        'using development environment credential; no vault credential found',
      );
    }
    return fallback;
  }

  /** Where a credential came from. Surfaced in the UI so the source is never a guess. */
  async describeSource(
    context: TenantContext,
    providerId: string,
  ): Promise<'vault' | 'environment' | 'none'> {
    if (await this.vault.resolve(context, providerId)) return 'vault';
    return this.envFallback(providerId) ? 'environment' : 'none';
  }
}
