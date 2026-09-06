import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  Database,
  CredentialStatus,
  credentials,
  organizations,
} from '@moka/db';
import {
  decryptCredential,
  encryptCredential,
  fingerprint as fingerprintOf,
  lastFour as lastFourOf,
  loadRootKey,
  unwrapDek,
} from '@moka/crypto';
import { assertSafeUrl } from '@moka/net';
import { loadConfig } from '@moka/config';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type TenantContext,
} from '@moka/core';
import type { ProviderCredential } from '@moka/ai';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { getLogger } from '../../common/logger.js';

/**
 * Moka Credentials — the credential vault (master prompt §4).
 *
 * THE ONE RULE
 * A plaintext secret exists in exactly two places: the request that creates it,
 * and the local variable inside `resolve()` that hands it to an adapter. It is
 * never stored, never logged, never returned, never placed in an error, and
 * never held in a cache. Every method below is written around that.
 *
 * WHAT A DTO MAY CONTAIN
 * `fingerprint` (irreversible), `lastFour` (display), and status. That is
 * enough to answer "which key is this?" without being enough to use it.
 *
 * ENCRYPTION
 * Envelope, with AES-GCM Additional Authenticated Data binding each ciphertext
 * to (organizationId, credentialId, providerId). A row copied to another
 * tenant does not decrypt — the cryptography refuses, not just a check.
 */

export interface CredentialDto {
  id: string;
  providerId: string;
  name: string;
  fingerprint: string;
  lastFour: string;
  baseUrl: string | null;
  status: string;
  isDefault: boolean;
  lastUsedAt: Date | null;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Providers that may be registered. Keeps a typo from creating dead rows. */
const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'google']);

@Injectable()
export class VaultService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /**
   * Unwrap this organization's data encryption key.
   *
   * Deliberately NOT cached. A DEK held in a process-wide map keyed by
   * organization is one bug away from being handed to the wrong tenant, and
   * the unwrap is a single AES-GCM operation — microseconds against a network
   * call to a provider.
   */
  private async organizationDek(context: TenantContext): Promise<Buffer> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({ dekWrapped: organizations.dekWrapped })
        .from(organizations)
        .where(eq(organizations.id, context.organizationId))
        .limit(1),
    );

    const wrapped = rows[0]?.dekWrapped;
    if (!wrapped) throw new NotFoundError('Organization');

    const rootKey = loadRootKey(loadConfig().ENCRYPTION_KEY);
    // Throws DecryptionFailedError if the row was moved between organizations.
    return unwrapDek(rootKey, Buffer.from(wrapped, 'base64'), context.organizationId);
  }

  async list(context: TenantContext): Promise<CredentialDto[]> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: credentials.id,
          providerId: credentials.providerId,
          name: credentials.name,
          fingerprint: credentials.fingerprint,
          lastFour: credentials.lastFour,
          baseUrl: credentials.baseUrl,
          status: credentials.status,
          isDefault: credentials.isDefault,
          lastUsedAt: credentials.lastUsedAt,
          lastTestedAt: credentials.lastTestedAt,
          lastTestOk: credentials.lastTestOk,
          revokedAt: credentials.revokedAt,
          createdAt: credentials.createdAt,
        })
        // ciphertext / iv / auth_tag are deliberately absent from this select.
        .from(credentials)
        .where(eq(credentials.organizationId, context.organizationId))
        .orderBy(desc(credentials.createdAt)),
    );
    return rows;
  }

  async create(
    context: TenantContext,
    input: {
      providerId: string;
      name: string;
      apiKey: string;
      baseUrl?: string | null;
      makeDefault?: boolean;
    },
    meta: { requestId?: string | undefined },
  ): Promise<CredentialDto> {
    if (!SUPPORTED_PROVIDERS.has(input.providerId)) {
      throw new ValidationError({ providerId: `Unsupported provider "${input.providerId}".` });
    }

    // A BYOK endpoint is attacker-reachable input. Validate before storing, so
    // an unusable or hostile URL never reaches the database at all.
    if (input.baseUrl) {
      try {
        assertSafeUrl(input.baseUrl);
      } catch {
        throw new ValidationError({
          baseUrl: 'Endpoint must be a public https:// or http:// URL.',
        });
      }
    }

    const apiKey = input.apiKey.trim();
    if (apiKey.length < 8) {
      throw new ValidationError({ apiKey: 'That does not look like an API key.' });
    }

    // The id must exist BEFORE encryption: it is part of the AAD.
    const credentialId = randomUUID();
    const dek = await this.organizationDek(context);

    const sealed = encryptCredential(dek, apiKey, {
      organizationId: context.organizationId,
      credentialId,
      providerId: input.providerId,
    });

    const record = {
      id: credentialId,
      organizationId: context.organizationId,
      providerId: input.providerId,
      name: input.name.trim(),
      ciphertext: sealed.ciphertext.toString('base64'),
      iv: sealed.iv.toString('base64'),
      authTag: sealed.authTag.toString('base64'),
      fingerprint: fingerprintOf(apiKey),
      lastFour: lastFourOf(apiKey),
      baseUrl: input.baseUrl ?? null,
      createdBy: context.userId,
    };

    try {
      await this.db.withTenant(context, async (tx) => {
        if (input.makeDefault) {
          await tx
            .update(credentials)
            .set({ isDefault: false })
            .where(
              and(
                eq(credentials.organizationId, context.organizationId),
                eq(credentials.providerId, input.providerId),
              ),
            );
        }
        await tx.insert(credentials).values({ ...record, isDefault: input.makeDefault ?? true });
      });
    } catch (error) {
      // A duplicate fingerprint means this exact key is already stored. Say so
      // without confirming anything about the stored value.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('That API key is already stored for this provider.');
      }
      throw error;
    }

    await this.audit.record(context, {
      action: 'credential.create',
      resourceType: 'credential',
      resourceId: credentialId,
      // Only non-secret identifiers. The audit writer redacts too, but the
      // safest input is one that never contained a secret.
      after: {
        providerId: input.providerId,
        name: record.name,
        fingerprint: record.fingerprint,
        lastFour: record.lastFour,
      },
      requestId: meta.requestId,
    });

    return this.requireDto(context, credentialId);
  }

  /**
   * Decrypt a credential for use by an adapter.
   *
   * The ONLY method that produces plaintext. Returns null rather than throwing
   * when nothing usable exists, so the router can treat a missing credential
   * as a routing constraint instead of an exception.
   */
  async resolve(context: TenantContext, providerId: string): Promise<ProviderCredential | null> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .select({
          id: credentials.id,
          providerId: credentials.providerId,
          ciphertext: credentials.ciphertext,
          iv: credentials.iv,
          authTag: credentials.authTag,
          baseUrl: credentials.baseUrl,
        })
        .from(credentials)
        .where(
          and(
            eq(credentials.organizationId, context.organizationId),
            eq(credentials.providerId, providerId),
            // Revoked and disabled credentials are invisible here. This is the
            // point at which revocation actually takes effect.
            eq(credentials.status, CredentialStatus.ACTIVE),
          ),
        )
        .orderBy(desc(credentials.isDefault), desc(credentials.createdAt))
        .limit(1),
    );

    const row = rows[0];
    if (!row) return null;

    const dek = await this.organizationDek(context);
    let apiKey: string;
    try {
      apiKey = decryptCredential(
        dek,
        {
          ciphertext: Buffer.from(row.ciphertext, 'base64'),
          iv: Buffer.from(row.iv, 'base64'),
          authTag: Buffer.from(row.authTag, 'base64'),
        },
        {
          organizationId: context.organizationId,
          credentialId: row.id,
          providerId: row.providerId,
        },
      );
    } catch {
      /*
       * AAD mismatch or tampering. This is a security event, not a routine
       * failure: it means a stored row does not belong where it sits.
       * The credential is treated as unusable rather than the error surfacing
       * anything about the stored bytes.
       */
      getLogger().error(
        {
          securityEvent: true,
          type: 'credential.decrypt_failed',
          organizationId: context.organizationId,
          credentialId: row.id,
          providerId: row.providerId,
        },
        'security.credential.decrypt_failed',
      );
      return null;
    }

    // Re-validate a stored BYOK endpoint at USE time, not only at write time:
    // the SSRF ruleset can tighten after a row was written.
    if (row.baseUrl) {
      try {
        assertSafeUrl(row.baseUrl);
      } catch {
        getLogger().warn(
          { credentialId: row.id, organizationId: context.organizationId },
          'stored credential endpoint failed SSRF validation; ignoring credential',
        );
        return null;
      }
    }

    // Fire-and-forget: a last-used timestamp must never fail a real request.
    void this.touch(context, row.id);

    return { apiKey, ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}) };
  }

  /** Providers this organization holds a usable credential for. */
  async availableProviders(context: TenantContext): Promise<string[]> {
    const rows = await this.db.withTenant(context, async (tx) =>
      tx
        .selectDistinct({ providerId: credentials.providerId })
        .from(credentials)
        .where(
          and(
            eq(credentials.organizationId, context.organizationId),
            eq(credentials.status, CredentialStatus.ACTIVE),
          ),
        ),
    );
    return rows.map((row) => row.providerId);
  }

  async revoke(
    context: TenantContext,
    credentialId: string,
    meta: { requestId?: string | undefined },
  ): Promise<CredentialDto> {
    const before = await this.requireDto(context, credentialId);

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(credentials)
        .set({
          status: CredentialStatus.REVOKED,
          revokedAt: new Date(),
          isDefault: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'credential.revoke',
      resourceType: 'credential',
      resourceId: credentialId,
      before: { status: before.status, providerId: before.providerId },
      after: { status: CredentialStatus.REVOKED },
      requestId: meta.requestId,
    });

    return this.requireDto(context, credentialId);
  }

  /**
   * Permanently remove a credential.
   *
   * Distinct from revoke: revocation keeps the record for audit, deletion
   * honours "remove my key from your systems". The audit row survives, because
   * it never contained the secret.
   */
  async remove(
    context: TenantContext,
    credentialId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const before = await this.requireDto(context, credentialId);

    await this.db.withTenant(context, async (tx) => {
      await tx
        .delete(credentials)
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'credential.delete',
      resourceType: 'credential',
      resourceId: credentialId,
      before: {
        providerId: before.providerId,
        name: before.name,
        fingerprint: before.fingerprint,
      },
      requestId: meta.requestId,
    });
  }

  /**
   * Rotate: replace the secret, keep the record.
   *
   * The credential id is unchanged, so the AAD is unchanged and everything
   * referencing this credential keeps working. Only the ciphertext moves.
   */
  async rotate(
    context: TenantContext,
    credentialId: string,
    newApiKey: string,
    meta: { requestId?: string | undefined },
  ): Promise<CredentialDto> {
    const existing = await this.requireDto(context, credentialId);
    const apiKey = newApiKey.trim();
    if (apiKey.length < 8) {
      throw new ValidationError({ apiKey: 'That does not look like an API key.' });
    }

    const dek = await this.organizationDek(context);
    const sealed = encryptCredential(dek, apiKey, {
      organizationId: context.organizationId,
      credentialId,
      providerId: existing.providerId,
    });

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(credentials)
        .set({
          ciphertext: sealed.ciphertext.toString('base64'),
          iv: sealed.iv.toString('base64'),
          authTag: sealed.authTag.toString('base64'),
          fingerprint: fingerprintOf(apiKey),
          lastFour: lastFourOf(apiKey),
          rotatedAt: new Date(),
          updatedAt: new Date(),
          // A rotated key has not been tested yet; stale results would mislead.
          lastTestedAt: null,
          lastTestOk: null,
        })
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'credential.rotate',
      resourceType: 'credential',
      resourceId: credentialId,
      before: { fingerprint: existing.fingerprint, lastFour: existing.lastFour },
      after: { fingerprint: fingerprintOf(apiKey), lastFour: lastFourOf(apiKey) },
      requestId: meta.requestId,
    });

    return this.requireDto(context, credentialId);
  }

  async setEnabled(
    context: TenantContext,
    credentialId: string,
    enabled: boolean,
    meta: { requestId?: string | undefined },
  ): Promise<CredentialDto> {
    const before = await this.requireDto(context, credentialId);
    if (before.status === CredentialStatus.REVOKED) {
      // Revocation is deliberately one-way.
      throw new ConflictError('A revoked credential cannot be re-enabled.');
    }

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(credentials)
        .set({
          status: enabled ? CredentialStatus.ACTIVE : CredentialStatus.DISABLED,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: enabled ? 'credential.enable' : 'credential.disable',
      resourceType: 'credential',
      resourceId: credentialId,
      before: { status: before.status },
      after: { status: enabled ? CredentialStatus.ACTIVE : CredentialStatus.DISABLED },
      requestId: meta.requestId,
    });

    return this.requireDto(context, credentialId);
  }

  /** Record the outcome of a connection test. */
  async recordTestResult(
    context: TenantContext,
    credentialId: string,
    ok: boolean,
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(credentials)
        .set({ lastTestedAt: new Date(), lastTestOk: ok, updatedAt: new Date() })
        .where(
          and(
            eq(credentials.id, credentialId),
            eq(credentials.organizationId, context.organizationId),
          ),
        );
    });
  }

  async requireDto(context: TenantContext, credentialId: string): Promise<CredentialDto> {
    const found = (await this.list(context)).find((row) => row.id === credentialId);
    if (!found) throw new NotFoundError('Credential');
    return found;
  }

  private async touch(context: TenantContext, credentialId: string): Promise<void> {
    try {
      await this.db.withTenant(context, async (tx) => {
        await tx
          .update(credentials)
          .set({ lastUsedAt: new Date() })
          .where(
            and(
              eq(credentials.id, credentialId),
              eq(credentials.organizationId, context.organizationId),
            ),
          );
      });
    } catch {
      // Non-fatal by design: a bookkeeping write must not fail a real request.
    }
  }
}
