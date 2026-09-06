import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { ProviderError, createAnthropicAdapter, createOpenAiAdapter } from '@moka/ai';
import { VaultService } from './vault.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

/**
 * Moka Credentials API (master prompt §4).
 *
 * Every response here is built from `CredentialDto`, which by construction
 * contains no ciphertext, no IV, no auth tag and no plaintext. The only
 * key-derived fields exposed are an irreversible fingerprint and the last four
 * characters.
 *
 * Credential management is gated on ORG_UPDATE rather than a project
 * permission: a provider key is organization-wide infrastructure, and someone
 * who can create projects should not thereby be able to add or revoke the key
 * that every project bills against.
 */

const idSchema = z.string().uuid();

const createSchema = z.object({
  providerId: z.enum(['anthropic', 'openai', 'google']),
  name: z.string().min(1).max(120),
  // Bounded so an oversized body cannot be used to probe memory behaviour.
  apiKey: z.string().min(8).max(1000),
  baseUrl: z.string().url().max(500).nullish(),
  makeDefault: z.boolean().optional(),
});

const rotateSchema = z.object({ apiKey: z.string().min(8).max(1000) });
const enabledSchema = z.object({ enabled: z.boolean() });

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    /*
     * Only the field PATH is reported, never the value. A validation message
     * that echoed the rejected input would put an API key into an error
     * response, a log line, and probably a browser console.
     */
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/credentials')
export class CredentialsController {
  constructor(private readonly vault: VaultService) {}

  @RequirePermission(Permission.ORG_READ)
  @Get()
  async list(@CurrentTenant() tenant: TenantContext) {
    return { credentials: await this.vault.list(tenant) };
  }

  @RequirePermission(Permission.ORG_UPDATE)
  @Post()
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(createSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));
    return {
      credential: await this.vault.create(
        tenant,
        {
          providerId: input.providerId,
          name: input.name,
          apiKey: input.apiKey,
          baseUrl: input.baseUrl ?? null,
          ...(input.makeDefault !== undefined ? { makeDefault: input.makeDefault } : {}),
        },
        { requestId },
      ),
    };
  }

  /**
   * Test a stored credential by making the smallest real provider call
   * available, then recording the outcome.
   *
   * The plaintext key is decrypted, used, and discarded inside this request.
   * The response says only whether it worked — a provider's rejection message
   * can quote the key prefix, so it is never forwarded.
   */
  @RequirePermission(Permission.ORG_UPDATE)
  @Post(':id/test')
  async test(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    const credentialId = parse(idSchema, id);
    const credential = await this.vault.requireDto(tenant, credentialId);

    const resolved = await this.vault.resolve(tenant, credential.providerId);
    if (!resolved) {
      await this.vault.recordTestResult(tenant, credentialId, false);
      return {
        ok: false,
        reason: 'This credential is revoked or disabled, so it cannot be tested.',
      };
    }

    const factory =
      credential.providerId === 'anthropic'
        ? createAnthropicAdapter
        : credential.providerId === 'openai'
          ? createOpenAiAdapter
          : null;

    if (!factory) {
      return {
        ok: false,
        reason: `Connection testing is not implemented for ${credential.providerId}.`,
      };
    }

    try {
      // One token, one word. Enough to prove authentication without spending.
      await factory(resolved).chat(
        { model: null, messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 },
        credential.providerId === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini',
      );
      await this.vault.recordTestResult(tenant, credentialId, true);
      return { ok: true };
    } catch (error) {
      await this.vault.recordTestResult(tenant, credentialId, false);

      // Normalised, provider-agnostic reason only.
      const reason =
        error instanceof ProviderError
          ? error.publicMessage
          : 'The provider could not be reached.';
      return {
        ok: false,
        reason,
        ...(error instanceof ProviderError ? { providerCode: error.code } : {}),
      };
    }
  }

  @RequirePermission(Permission.ORG_UPDATE)
  @Post(':id/rotate')
  async rotate(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(rotateSchema, body);
    return {
      credential: await this.vault.rotate(tenant, parse(idSchema, id), input.apiKey, { requestId }),
    };
  }

  @RequirePermission(Permission.ORG_UPDATE)
  @Patch(':id')
  async setEnabled(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(enabledSchema, body);
    return {
      credential: await this.vault.setEnabled(tenant, parse(idSchema, id), input.enabled, {
        requestId,
      }),
    };
  }

  /** Revoke: one-way, keeps the record for audit. */
  @RequirePermission(Permission.ORG_UPDATE)
  @Post(':id/revoke')
  async revoke(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    return { credential: await this.vault.revoke(tenant, parse(idSchema, id), { requestId }) };
  }

  /** Delete: permanent. Honours "remove my key from your systems". */
  @RequirePermission(Permission.ORG_DELETE)
  @Delete(':id')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.vault.remove(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }
}
