import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  Database,
  chatConversations,
  chatMessages,
  chatbotDeployments,
  chatbotSources,
  chatbots,
  knowledgeSources,
} from '@moka/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type TenantContext,
} from '@moka/core';
import { ChatRole, generateDeploymentKey, parseAllowedOrigin, visitorLabel } from '@moka/chat';
import { Feature } from '@moka/billing';
import { DATABASE } from '../../database/database.module.js';
import { AuditService } from '../../common/audit.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';

/**
 * Staff-side chatbot management (§22).
 *
 * Everything here runs under `withTenant`, as an authenticated member with a
 * checked role. It is the ordinary half of the phase; the interesting half is
 * `visitor.service.ts`, which serves people who are not members at all.
 *
 * One asymmetry worth noticing: attaching a knowledge source here is a
 * PUBLICATION decision. It is the moment an internal document becomes
 * something a stranger can be read excerpts of, and the UI says so in those
 * words rather than calling it "scope".
 */

export interface ChatbotDto {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  greeting: string | null;
  modelId: string | null;
  requireGrounding: boolean;
  minPassages: number;
  maxPassages: number;
  handoffEnabled: boolean;
  retentionDays: number;
  status: string;
  sourceIds: string[];
  createdAt: Date;
}

export interface DeploymentDto {
  id: string;
  chatbotId: string;
  name: string;
  publicKey: string;
  allowedOrigins: string[];
  messagesPerMinute: number;
  conversationsPerHour: number;
  status: string;
  createdAt: Date;
}

@Injectable()
export class ChatbotsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Chatbots                                                                */
  /* ---------------------------------------------------------------------- */

  async list(context: TenantContext): Promise<ChatbotDto[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select()
        .from(chatbots)
        .where(and(eq(chatbots.organizationId, context.organizationId), isNull(chatbots.deletedAt)))
        .orderBy(desc(chatbots.createdAt));

      const links = await tx
        .select({ chatbotId: chatbotSources.chatbotId, sourceId: chatbotSources.sourceId })
        .from(chatbotSources)
        .where(eq(chatbotSources.organizationId, context.organizationId));

      const byBot = new Map<string, string[]>();
      for (const link of links) {
        byBot.set(link.chatbotId, [...(byBot.get(link.chatbotId) ?? []), link.sourceId]);
      }

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        greeting: row.greeting,
        modelId: row.modelId,
        requireGrounding: row.requireGrounding,
        minPassages: row.minPassages,
        maxPassages: row.maxPassages,
        handoffEnabled: row.handoffEnabled,
        retentionDays: row.retentionDays,
        status: row.status,
        sourceIds: byBot.get(row.id) ?? [],
        createdAt: row.createdAt,
      }));
    });
  }

  async get(context: TenantContext, chatbotId: string): Promise<ChatbotDto> {
    const found = (await this.list(context)).find((bot) => bot.id === chatbotId);
    if (!found) throw new NotFoundError('Chatbot');
    return found;
  }

  async create(
    context: TenantContext,
    input: {
      name: string;
      description?: string | null;
      instructions: string;
      greeting?: string | null;
      requireGrounding: boolean;
      handoffEnabled: boolean;
      retentionDays: number;
    },
    meta: { requestId?: string | undefined },
  ): Promise<ChatbotDto> {
    await this.entitlements.requireQuota(context, Feature.CHATBOTS_MAX);

    const id = await this.db.withTenant(context, async (tx) => {
      const [row] = await tx
        .insert(chatbots)
        .values({
          organizationId: context.organizationId,
          name: input.name.trim(),
          description: input.description ?? null,
          instructions: input.instructions,
          greeting: input.greeting ?? null,
          requireGrounding: input.requireGrounding,
          handoffEnabled: input.handoffEnabled,
          retentionDays: input.retentionDays,
          createdBy: context.userId,
        })
        .returning({ id: chatbots.id });
      if (!row) throw new ConflictError('The chatbot could not be created.');
      return row.id;
    });

    await this.audit.record(context, {
      action: 'chatbot.create',
      resourceType: 'chatbot',
      resourceId: id,
      after: { name: input.name, requireGrounding: input.requireGrounding },
      requestId: meta.requestId,
    });

    return this.get(context, id);
  }

  async update(
    context: TenantContext,
    chatbotId: string,
    input: Partial<{
      name: string;
      description: string | null;
      instructions: string;
      greeting: string | null;
      requireGrounding: boolean;
      handoffEnabled: boolean;
      retentionDays: number;
      status: string;
      modelId: string | null;
    }>,
    meta: { requestId?: string | undefined },
  ): Promise<ChatbotDto> {
    const before = await this.get(context, chatbotId);

    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(chatbots)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(eq(chatbots.id, chatbotId), eq(chatbots.organizationId, context.organizationId)),
        );
    });

    await this.audit.record(context, {
      action: 'chatbot.update',
      resourceType: 'chatbot',
      resourceId: chatbotId,
      before: { status: before.status, requireGrounding: before.requireGrounding },
      after: input,
      requestId: meta.requestId,
    });

    return this.get(context, chatbotId);
  }

  async remove(
    context: TenantContext,
    chatbotId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const before = await this.get(context, chatbotId);

    await this.db.withTenant(context, async (tx) => {
      /*
       * Deleting the chatbot revokes its deployments in the same transaction.
       * A soft-deleted bot whose keys still resolved would be a bot that was
       * "deleted" in the UI and still answering the public — the two must not
       * be able to disagree.
       */
      await tx
        .update(chatbots)
        .set({ deletedAt: new Date(), status: 'disabled' })
        .where(
          and(eq(chatbots.id, chatbotId), eq(chatbots.organizationId, context.organizationId)),
        );

      await tx
        .update(chatbotDeployments)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(
          and(
            eq(chatbotDeployments.chatbotId, chatbotId),
            eq(chatbotDeployments.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'chatbot.delete',
      resourceType: 'chatbot',
      resourceId: chatbotId,
      before: { name: before.name },
      requestId: meta.requestId,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Sources — the publication boundary                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Replace the set of knowledge sources this chatbot may quote.
   *
   * Every id is checked to belong to this organization before it is stored.
   * RLS would refuse a foreign source anyway — the foreign key would fail
   * against a row the transaction cannot see — but a clear rejection here
   * beats a constraint violation surfacing as a 500.
   */
  async setSources(
    context: TenantContext,
    chatbotId: string,
    sourceIds: readonly string[],
    meta: { requestId?: string | undefined },
  ): Promise<ChatbotDto> {
    await this.get(context, chatbotId);
    const unique = [...new Set(sourceIds)];

    await this.db.withTenant(context, async (tx) => {
      if (unique.length > 0) {
        const owned = await tx
          .select({ id: knowledgeSources.id })
          .from(knowledgeSources)
          .where(
            and(
              eq(knowledgeSources.organizationId, context.organizationId),
              isNull(knowledgeSources.deletedAt),
            ),
          );
        const ownedIds = new Set(owned.map((row) => row.id));
        const unknown = unique.filter((id) => !ownedIds.has(id));
        if (unknown.length > 0) {
          throw new ValidationError({ sourceIds: 'One or more sources do not exist.' });
        }
      }

      await tx
        .delete(chatbotSources)
        .where(
          and(
            eq(chatbotSources.chatbotId, chatbotId),
            eq(chatbotSources.organizationId, context.organizationId),
          ),
        );

      if (unique.length > 0) {
        await tx.insert(chatbotSources).values(
          unique.map((sourceId) => ({
            organizationId: context.organizationId,
            chatbotId,
            sourceId,
            attachedBy: context.userId,
          })),
        );
      }
    });

    await this.audit.record(context, {
      action: 'chatbot.sources.publish',
      resourceType: 'chatbot',
      resourceId: chatbotId,
      after: { sourceIds: unique },
      requestId: meta.requestId,
    });

    return this.get(context, chatbotId);
  }

  /* ---------------------------------------------------------------------- */
  /* Deployments                                                             */
  /* ---------------------------------------------------------------------- */

  async listDeployments(context: TenantContext, chatbotId?: string): Promise<DeploymentDto[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select()
        .from(chatbotDeployments)
        .where(
          chatbotId
            ? and(
                eq(chatbotDeployments.organizationId, context.organizationId),
                eq(chatbotDeployments.chatbotId, chatbotId),
              )
            : eq(chatbotDeployments.organizationId, context.organizationId),
        )
        .orderBy(desc(chatbotDeployments.createdAt));

      return rows.map((row) => ({
        id: row.id,
        chatbotId: row.chatbotId,
        name: row.name,
        // Returned in full, unlike a credential. It is public by design and
        // the operator has to be able to copy it into their page.
        publicKey: row.publicKey,
        allowedOrigins: row.allowedOrigins ?? [],
        messagesPerMinute: row.messagesPerMinute,
        conversationsPerHour: row.conversationsPerHour,
        status: row.status,
        createdAt: row.createdAt,
      }));
    });
  }

  async createDeployment(
    context: TenantContext,
    chatbotId: string,
    input: { name: string; allowedOrigins: readonly string[] },
    meta: { requestId?: string | undefined },
  ): Promise<DeploymentDto> {
    await this.get(context, chatbotId);
    // Counted across the organization, not per chatbot: a deployment is a
    // published surface, and the plan sells a number of them.
    await this.entitlements.requireQuota(context, Feature.CHATBOT_DEPLOYMENTS_MAX);

    /*
     * Origins are normalised and validated BEFORE storage, so the stored list
     * only ever contains values this system understands. That matters twice
     * over: the list is compared against request Origins, and it is
     * interpolated into a `frame-ancestors` CSP directive. An entry containing
     * a semicolon would terminate that directive and start another one.
     */
    const normalised: string[] = [];
    for (const raw of input.allowedOrigins) {
      const parsed = parseAllowedOrigin(raw);
      if (!parsed) {
        throw new ValidationError({
          allowedOrigins: `"${raw.slice(0, 80)}" is not an origin. Use https://example.com or https://*.example.com.`,
        });
      }
      normalised.push(parsed.raw);
    }

    const row = await this.db.withTenant(context, async (tx) => {
      const [inserted] = await tx
        .insert(chatbotDeployments)
        .values({
          organizationId: context.organizationId,
          chatbotId,
          name: input.name.trim(),
          publicKey: generateDeploymentKey(),
          allowedOrigins: [...new Set(normalised)],
          createdBy: context.userId,
        })
        .returning({ id: chatbotDeployments.id });
      return inserted;
    });

    if (!row) throw new ConflictError('The deployment could not be created.');

    await this.audit.record(context, {
      action: 'chatbot.deployment.create',
      resourceType: 'chatbot_deployment',
      resourceId: row.id,
      after: { chatbotId, allowedOrigins: normalised },
      requestId: meta.requestId,
    });

    const created = (await this.listDeployments(context, chatbotId)).find((d) => d.id === row.id);
    if (!created) throw new NotFoundError('Deployment');
    return created;
  }

  /**
   * Revoke a deployment.
   *
   * Immediate: the narrow RLS policy that resolves a public key requires
   * `status = 'active'`, so the key stops resolving on the next request. There
   * is nothing to expire and no cache to wait out.
   */
  async revokeDeployment(
    context: TenantContext,
    deploymentId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    const updated = await this.db.withTenant(context, async (tx) =>
      tx
        .update(chatbotDeployments)
        .set({ status: 'revoked', revokedAt: new Date() })
        .where(
          and(
            eq(chatbotDeployments.id, deploymentId),
            eq(chatbotDeployments.organizationId, context.organizationId),
          ),
        )
        .returning({ id: chatbotDeployments.id }),
    );

    if (updated.length === 0) throw new NotFoundError('Deployment');

    await this.audit.record(context, {
      action: 'chatbot.deployment.revoke',
      resourceType: 'chatbot_deployment',
      resourceId: deploymentId,
      requestId: meta.requestId,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Conversations and handoff                                               */
  /* ---------------------------------------------------------------------- */

  async listConversations(context: TenantContext, filter: { status?: string } = {}) {
    return this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select({
          id: chatConversations.id,
          chatbotId: chatConversations.chatbotId,
          status: chatConversations.status,
          origin: chatConversations.origin,
          messageCount: chatConversations.messageCount,
          handoffRequestedAt: chatConversations.handoffRequestedAt,
          startedAt: chatConversations.startedAt,
          lastActivityAt: chatConversations.lastActivityAt,
        })
        .from(chatConversations)
        .where(
          filter.status
            ? and(
                eq(chatConversations.organizationId, context.organizationId),
                eq(chatConversations.status, filter.status),
              )
            : eq(chatConversations.organizationId, context.organizationId),
        )
        .orderBy(desc(chatConversations.lastActivityAt))
        .limit(100);

      return rows.map((row) => ({
        ...row,
        // A per-conversation pseudonym. Staff need to tell two live
        // conversations apart; they do not need an identifier that follows a
        // person between visits, so we do not compute one.
        visitor: visitorLabel(row.id),
      }));
    });
  }

  async getTranscript(context: TenantContext, conversationId: string) {
    return this.db.withTenant(context, async (tx) => {
      const conversation = await tx
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.id, conversationId),
            eq(chatConversations.organizationId, context.organizationId),
          ),
        )
        .limit(1);

      if (conversation.length === 0) throw new NotFoundError('Conversation');

      const messages = await tx
        .select({
          id: chatMessages.id,
          role: chatMessages.role,
          content: chatMessages.content,
          citations: chatMessages.citations,
          errorCode: chatMessages.errorCode,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, conversationId))
        .orderBy(asc(chatMessages.createdAt))
        .limit(500);

      const row = conversation[0]!;
      return {
        conversation: {
          id: row.id,
          chatbotId: row.chatbotId,
          status: row.status,
          origin: row.origin,
          visitor: visitorLabel(row.id),
          handoffRequestedAt: row.handoffRequestedAt,
          startedAt: row.startedAt,
          lastActivityAt: row.lastActivityAt,
        },
        messages,
      };
    });
  }

  /**
   * A staff member takes over a conversation and replies in it.
   *
   * The reply is stored with role 'human' and the author's user id, so a
   * transcript never blurs which sentences a person wrote and which a model
   * did. The visitor's widget labels them differently for the same reason.
   */
  async replyAsHuman(
    context: TenantContext,
    conversationId: string,
    text: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .select({ id: chatConversations.id, status: chatConversations.status })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.id, conversationId),
            eq(chatConversations.organizationId, context.organizationId),
          ),
        )
        .limit(1);

      const conversation = rows[0];
      if (!conversation) throw new NotFoundError('Conversation');
      if (conversation.status === 'closed') {
        throw new ConflictError('That conversation is closed.');
      }

      await tx.insert(chatMessages).values({
        organizationId: context.organizationId,
        conversationId,
        role: ChatRole.AGENT_HUMAN,
        content: text,
        authorUserId: context.userId,
      });

      await tx
        .update(chatConversations)
        .set({
          status: 'with_human',
          handoffClaimedBy: context.userId,
          handoffClaimedAt: new Date(),
          lastActivityAt: new Date(),
        })
        .where(eq(chatConversations.id, conversationId));
    });

    await this.audit.record(context, {
      action: 'chat.human_reply',
      resourceType: 'chat_conversation',
      resourceId: conversationId,
      requestId: meta.requestId,
    });
  }

  async closeConversation(
    context: TenantContext,
    conversationId: string,
    meta: { requestId?: string | undefined },
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      await tx
        .update(chatConversations)
        .set({ status: 'closed', closedAt: new Date() })
        .where(
          and(
            eq(chatConversations.id, conversationId),
            eq(chatConversations.organizationId, context.organizationId),
          ),
        );
    });

    await this.audit.record(context, {
      action: 'chat.conversation.close',
      resourceType: 'chat_conversation',
      resourceId: conversationId,
      requestId: meta.requestId,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Retention                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Delete conversations older than their chatbot's retention window.
   *
   * ON-DEMAND ONLY. This is the honest state of it: there is no scheduler
   * here, because the job queue needs Valkey and Valkey needs Docker, which is
   * unavailable on this machine (docs/roadmap.md §B2). Rather than ship a
   * timer that silently stops with the process — and let an operator believe
   * their retention policy is running — the endpoint is explicit and the UI
   * says it must be triggered.
   *
   * TODO(§B2): run this from the scheduled queue once Valkey exists.
   */
  async purgeExpiredConversations(
    context: TenantContext,
    meta: { requestId?: string | undefined },
  ): Promise<{ deleted: number }> {
    const deleted = await this.db.withTenant(context, async (tx) => {
      const rows = await tx
        .delete(chatConversations)
        .where(
          and(
            eq(chatConversations.organizationId, context.organizationId),
            lt(
              chatConversations.lastActivityAt,
              // Per-chatbot window, evaluated in SQL so one statement covers
              // every chatbot rather than one round trip each.
              sql`now() - make_interval(days => (
                SELECT b.retention_days FROM chatbots b WHERE b.id = ${chatConversations.chatbotId}
              ))`,
            ),
          ),
        )
        .returning({ id: chatConversations.id });
      return rows.length;
    });

    await this.audit.record(context, {
      action: 'chat.retention.purge',
      resourceType: 'chat_conversation',
      after: { deleted },
      requestId: meta.requestId,
    });

    return { deleted };
  }
}
