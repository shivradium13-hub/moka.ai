import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  Database,
  chatConversations,
  chatMessages,
  chatbotDeployments,
  chatbotSources,
  chatbots,
} from '@moka/db';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  createCustomerContext,
  type CustomerContext,
} from '@moka/core';
import {
  ChatRole,
  LIMITS,
  generateVisitorToken,
  hashVisitorToken,
  isDeploymentKeyFormat,
  originAllowed,
  parseAllowedOrigins,
  parseOrigin,
  type AllowedOriginPattern,
  type ChatMessage,
} from '@moka/chat';
import { DATABASE } from '../../database/database.module.js';
import { logSecurityEvent } from '../../common/logger.js';

/**
 * Turning a public request into a scoped, role-less principal (§22–23).
 *
 * This service is the entire trust boundary of the public chat surface. Every
 * value it returns is read back from the database; nothing a visitor sends
 * contributes to identity beyond naming which deployment and which
 * conversation they are talking about — and both of those are then verified.
 *
 * THE RESOLUTION ORDER, WHICH IS NOT NEGOTIABLE
 *
 *   public key  → deployment      (narrow RLS policy, no organization bound)
 *   deployment  → organization    (from the row, never from the request)
 *   visitor token + organization → conversation
 *   conversation → CustomerContext, which carries no role
 *
 * Each step is scoped by the previous one. A visitor token is only ever looked
 * up INSIDE the organization its public key resolved to, so presenting tenant
 * A's key with tenant B's token finds nothing at all rather than finding
 * something and then checking it.
 */

/** How long a visitor token stays valid. A conversation is not a login. */
const CONVERSATION_TTL_HOURS = 24;

export interface ResolvedDeployment {
  readonly deploymentId: string;
  readonly organizationId: string;
  readonly chatbotId: string;
  readonly allowedOrigins: readonly AllowedOriginPattern[];
  readonly messagesPerMinute: number;
  readonly conversationsPerHour: number;
}

export interface ResolvedChatbot {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly greeting: string | null;
  readonly modelId: string | null;
  readonly requireGrounding: boolean;
  readonly minPassages: number;
  readonly maxPassages: number;
  readonly handoffEnabled: boolean;
  /** The publication boundary: the ONLY sources this bot may quote. */
  readonly sourceIds: readonly string[];
}

export interface ResolvedConversation {
  readonly customer: CustomerContext;
  readonly status: string;
  readonly messageCount: number;
}

@Injectable()
export class VisitorService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Resolve a public key to its deployment.
   *
   * Runs with NO organization bound, under the narrow policy added in
   * 0007_chatbots.sql, which makes exactly one row visible: the active
   * deployment holding this key. A revoked deployment stops resolving here
   * immediately rather than expiring — revocation should be effective, not
   * eventual.
   *
   * Every failure raises the same error. An unknown key, a malformed key and a
   * revoked key are indistinguishable from outside, so a prober cannot use the
   * response to sort real keys from invented ones.
   */
  async resolveDeployment(publicKey: string): Promise<ResolvedDeployment> {
    if (!isDeploymentKeyFormat(publicKey)) throw new NotFoundError('Chatbot');

    const rows = await this.db.withDeploymentKey(publicKey, async (tx) =>
      tx
        .select({
          id: chatbotDeployments.id,
          organizationId: chatbotDeployments.organizationId,
          chatbotId: chatbotDeployments.chatbotId,
          allowedOrigins: chatbotDeployments.allowedOrigins,
          messagesPerMinute: chatbotDeployments.messagesPerMinute,
          conversationsPerHour: chatbotDeployments.conversationsPerHour,
        })
        .from(chatbotDeployments)
        .where(eq(chatbotDeployments.publicKey, publicKey))
        .limit(1),
    );

    const row = rows[0];
    if (!row) throw new NotFoundError('Chatbot');

    return {
      deploymentId: row.id,
      organizationId: row.organizationId,
      chatbotId: row.chatbotId,
      allowedOrigins: parseAllowedOrigins(row.allowedOrigins ?? []),
      messagesPerMinute: row.messagesPerMinute,
      conversationsPerHour: row.conversationsPerHour,
    };
  }

  /**
   * Check the request's Origin against the deployment's allowlist.
   *
   * BE CLEAR ABOUT WHAT THIS BUYS. The Origin header is set by browsers and
   * omitted entirely by `curl`. Anyone who reads the customer's page source
   * can replay these calls with any Origin they choose. This check stops a
   * deployment being casually dropped onto an unrelated site; it stops a
   * determined attacker from nothing.
   *
   * The control that actually holds is `frame-ancestors` on the chat frame,
   * which the visitor's own browser enforces — plus the fact that a visitor
   * principal carries no authority in the first place.
   *
   * A mismatch is logged as a security event because, weak or not, it is a
   * signal: a key appearing from an origin nobody configured is worth seeing.
   */
  assertOriginAllowed(
    deployment: ResolvedDeployment,
    originHeader: string | undefined,
    context: { requestId?: string | undefined },
  ): void {
    const origin = parseOrigin(originHeader ?? null);
    if (originAllowed(origin, deployment.allowedOrigins)) return;

    logSecurityEvent({
      type: 'chat.origin_not_allowed',
      requestId: context.requestId,
      organizationId: deployment.organizationId,
      detail: {
        deploymentId: deployment.deploymentId,
        // The presented origin, which is attacker-controlled data. Recorded
        // because it is the point of the event; never used for a decision.
        presented: origin?.value ?? '(absent)',
        allowedCount: deployment.allowedOrigins.length,
      },
    });

    /*
     * The argument is the INTERNAL message — ForbiddenError's public text is
     * fixed and generic, which is what we want here. The visitor learns only
     * that they cannot proceed, not whether the key was real, whether the
     * origin was close, or how many sites are configured.
     */
    throw new ForbiddenError('Chatbot deployment presented from an origin not on its allowlist.');
  }

  /** Load the chatbot's configuration and its published source allowlist. */
  async loadChatbot(deployment: ResolvedDeployment): Promise<ResolvedChatbot> {
    const scope = this.scopeOf(deployment);

    const { bot, sources } = await this.db.withScope(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(chatbots)
        .where(and(eq(chatbots.id, deployment.chatbotId), eq(chatbots.status, 'active')))
        .limit(1);

      const found = rows[0];
      if (!found) return { bot: null, sources: [] as string[] };

      const attached = await tx
        .select({ sourceId: chatbotSources.sourceId })
        .from(chatbotSources)
        .where(eq(chatbotSources.chatbotId, deployment.chatbotId));

      return { bot: found, sources: attached.map((row) => row.sourceId) };
    });

    /*
     * A deployment pointing at a draft, disabled or deleted chatbot resolves to
     * nothing — same error as an unknown key. Unpublishing a chatbot therefore
     * takes it offline everywhere at once, without having to hunt down and
     * revoke each deployment that referenced it.
     */
    if (!bot || bot.deletedAt) throw new NotFoundError('Chatbot');

    return {
      id: bot.id,
      name: bot.name,
      instructions: bot.instructions,
      greeting: bot.greeting,
      modelId: bot.modelId,
      requireGrounding: bot.requireGrounding,
      minPassages: bot.minPassages,
      maxPassages: bot.maxPassages,
      handoffEnabled: bot.handoffEnabled,
      sourceIds: sources,
    };
  }

  /** Open a new conversation and mint the token that identifies it. */
  async openConversation(
    deployment: ResolvedDeployment,
    origin: string | undefined,
  ): Promise<{ visitorToken: string; conversation: ResolvedConversation }> {
    const token = generateVisitorToken();
    const scope = this.scopeOf(deployment);

    const row = await this.db.withScope(scope, async (tx) => {
      const [inserted] = await tx
        .insert(chatConversations)
        .values({
          organizationId: deployment.organizationId,
          chatbotId: deployment.chatbotId,
          deploymentId: deployment.deploymentId,
          visitorTokenHash: hashVisitorToken(token),
          // Stored for the staff inbox. Deliberately the ONLY provenance we
          // keep: no IP, no fingerprint, nothing that follows a person between
          // visits. Staff need to tell conversations apart, not identify people.
          origin: parseOrigin(origin ?? null)?.value ?? null,
          expiresAt: new Date(Date.now() + CONVERSATION_TTL_HOURS * 3_600_000),
        })
        .returning({ id: chatConversations.id });
      return inserted;
    });

    if (!row) throw new ConflictError('The conversation could not be started.');

    return {
      visitorToken: token,
      conversation: {
        customer: createCustomerContext({
          organizationId: deployment.organizationId,
          chatbotId: deployment.chatbotId,
          deploymentId: deployment.deploymentId,
          conversationId: row.id,
          visitorId: row.id,
        }),
        status: 'open',
        messageCount: 0,
      },
    };
  }

  /**
   * Resolve an existing conversation from a visitor token.
   *
   * The lookup is scoped to the organization the PUBLIC KEY resolved to, so a
   * token belonging to another tenant is not found — rather than found and
   * then rejected. It also pins `deployment_id`: a token minted for one
   * deployment cannot be replayed against a different deployment of the same
   * organization, which might have a different origin allowlist.
   *
   * Returns null rather than throwing. A stale token from a previous visit is
   * an ordinary occurrence, not an error, and the caller responds by opening a
   * fresh conversation.
   */
  async resumeConversation(
    deployment: ResolvedDeployment,
    token: string,
  ): Promise<ResolvedConversation | null> {
    if (!token || token.length > 200) return null;
    const scope = this.scopeOf(deployment);

    const rows = await this.db.withScope(scope, async (tx) =>
      tx
        .select({
          id: chatConversations.id,
          status: chatConversations.status,
          messageCount: chatConversations.messageCount,
        })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.visitorTokenHash, hashVisitorToken(token)),
            eq(chatConversations.organizationId, deployment.organizationId),
            eq(chatConversations.deploymentId, deployment.deploymentId),
            gt(chatConversations.expiresAt, new Date()),
          ),
        )
        .limit(1),
    );

    const row = rows[0];
    if (!row) return null;
    if (row.status === 'closed') return null;

    return {
      customer: createCustomerContext({
        organizationId: deployment.organizationId,
        chatbotId: deployment.chatbotId,
        deploymentId: deployment.deploymentId,
        conversationId: row.id,
        visitorId: row.id,
      }),
      status: row.status,
      messageCount: row.messageCount,
    };
  }

  /** The transcript a visitor may read: their own conversation, and only that. */
  async listMessages(customer: CustomerContext): Promise<ChatMessage[]> {
    const rows = await this.db.withCustomer(customer, async (tx) =>
      tx
        .select({
          role: chatMessages.role,
          content: chatMessages.content,
          citations: chatMessages.citations,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, customer.conversationId))
        .orderBy(asc(chatMessages.createdAt))
        .limit(200),
    );

    return rows.map((row) => ({
      role: row.role as ChatRole,
      content: row.content,
      createdAt: row.createdAt,
    }));
  }

  /** The same transcript with citations, for rendering in the widget. */
  async listMessagesForWidget(customer: CustomerContext) {
    return this.db.withCustomer(customer, async (tx) =>
      tx
        .select({
          role: chatMessages.role,
          content: chatMessages.content,
          citations: chatMessages.citations,
        })
        .from(chatMessages)
        .where(eq(chatMessages.conversationId, customer.conversationId))
        .orderBy(asc(chatMessages.createdAt))
        .limit(200),
    );
  }

  async appendMessage(
    customer: CustomerContext,
    message: {
      role: ChatRole;
      content: string;
      citations?: unknown;
      errorCode?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      authorUserId?: string | null;
    },
  ): Promise<void> {
    await this.db.withCustomer(customer, async (tx) => {
      await tx.insert(chatMessages).values({
        organizationId: customer.organizationId,
        conversationId: customer.conversationId,
        role: message.role,
        content: message.content,
        citations: (message.citations ?? []) as never,
        errorCode: message.errorCode ?? null,
        inputTokens: message.inputTokens ?? 0,
        outputTokens: message.outputTokens ?? 0,
        authorUserId: message.authorUserId ?? null,
      });

      if (message.role === ChatRole.VISITOR) {
        await tx
          .update(chatConversations)
          .set({
            messageCount: sql`${chatConversations.messageCount} + 1`,
            lastActivityAt: new Date(),
          })
          .where(eq(chatConversations.id, customer.conversationId));
      } else {
        await tx
          .update(chatConversations)
          .set({ lastActivityAt: new Date() })
          .where(eq(chatConversations.id, customer.conversationId));
      }
    });
  }

  /**
   * Per-conversation message ceiling.
   *
   * Rate limiting slows a visitor down; this stops them. Without it, a single
   * conversation left running overnight is an open-ended bill against a paid
   * provider, payable by the organization and startable by anyone who can load
   * the customer's home page.
   */
  assertWithinConversationBudget(conversation: ResolvedConversation): void {
    if (conversation.messageCount >= LIMITS.MAX_MESSAGES_PER_CONVERSATION) {
      throw new ConflictError(
        'This conversation has reached its length limit. Please start a new one.',
      );
    }
  }

  /** Mark a conversation as waiting for a person. */
  async requestHandoff(customer: CustomerContext): Promise<void> {
    await this.db.withCustomer(customer, async (tx) => {
      await tx
        .update(chatConversations)
        .set({ status: 'awaiting_human', handoffRequestedAt: new Date(), lastActivityAt: new Date() })
        .where(
          and(
            eq(chatConversations.id, customer.conversationId),
            // Only from a live conversation. A closed one cannot be reopened
            // by a replayed token.
            eq(chatConversations.status, 'open'),
          ),
        );
    });
  }

  /**
   * The organization scope implied by a resolved deployment.
   *
   * A CustomerContext with placeholder conversation fields, used for the two
   * queries that happen BEFORE a conversation exists: loading the chatbot, and
   * creating the conversation itself. Only `organizationId` is read by the
   * binding, and the placeholders never leave this file.
   */
  private scopeOf(deployment: ResolvedDeployment): CustomerContext {
    return createCustomerContext({
      organizationId: deployment.organizationId,
      chatbotId: deployment.chatbotId,
      deploymentId: deployment.deploymentId,
      conversationId: deployment.deploymentId,
      visitorId: deployment.deploymentId,
    });
  }
}
