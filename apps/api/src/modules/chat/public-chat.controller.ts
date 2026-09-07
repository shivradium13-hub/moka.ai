import { Body, Controller, Headers, Inject, Ip, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '@moka/core';
import { ChatRole, LIMITS, validateVisitorMessage, greetingFor } from '@moka/chat';
import { Public, RequestId } from '../../common/decorators.js';
import { RATE_LIMITER, enforceRateLimit, type RateLimiter } from '../../common/rate-limit.js';
import { AuditService } from '../../common/audit.service.js';
import { VisitorService, type ResolvedDeployment } from './visitor.service.js';
import { SupportAgentService } from './support-agent.service.js';

/**
 * The public chat API (§22–24).
 *
 * THE ONLY UNAUTHENTICATED, INTERNET-FACING SURFACE IN THE SYSTEM.
 *
 * Everything that reaches here is untrusted, including the shape of the
 * request. Four properties hold on every route below:
 *
 *  1. TENANT IDENTITY COMES FROM THE PUBLIC KEY, resolved against the database
 *     under a narrow RLS policy. Nothing in the body contributes to it, and
 *     there is no organization id to forge because none is accepted.
 *
 *  2. THE RESULTING PRINCIPAL HOLDS NO ROLE. A `CustomerContext` has no field
 *     from which a permission can be derived, so no handler here can be
 *     tricked into an authorisation decision — there is nothing to decide with.
 *
 *  3. NO COOKIES. The visitor token travels in a header, so these endpoints
 *     carry no ambient authority and there is nothing for a cross-site request
 *     to ride on. CORS is consequently NOT a security control here, and is not
 *     treated as one (see main.ts).
 *
 *  4. RATE LIMITED ON TWO KEYS. Per conversation and per IP-and-deployment,
 *     because the spend lands on the organization that published the bot and
 *     the trigger is anyone who can load their home page.
 */

const sessionSchema = z.object({
  publicKey: z.string().min(1).max(120),
  /** A token from a previous turn in this tab, if any. */
  resume: z.string().max(200).nullish(),
});

const messageSchema = z.object({ message: z.string().min(1).max(LIMITS.MAX_MESSAGE_CHARS) });

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Public()
@Controller('public/chat')
export class PublicChatController {
  constructor(
    private readonly visitors: VisitorService,
    private readonly support: SupportAgentService,
    private readonly audit: AuditService,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /**
   * Open or resume a conversation.
   *
   * Returns the chatbot's public configuration and, when resuming, the
   * transcript so far. The configuration returned is deliberately a hand-built
   * subset: name, greeting, and whether handoff is offered. Not the operator
   * instructions, not the model, not the source list — a visitor has no need
   * of them, and each would tell someone probing the bot how to work on it.
   */
  @Post('session')
  async session(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Ip() ip: string,
    @RequestId() requestId: string,
  ) {
    const input = parse(sessionSchema, body);

    const deployment = await this.visitors.resolveDeployment(input.publicKey);
    this.visitors.assertOriginAllowed(deployment, origin, { requestId });

    const chatbot = await this.visitors.loadChatbot(deployment);

    // Resuming is free; opening a new conversation is what gets limited, since
    // that is the operation that creates a row and can be repeated forever.
    const existing = input.resume
      ? await this.visitors.resumeConversation(deployment, input.resume)
      : null;

    if (!existing) {
      await enforceRateLimit(
        this.limiter,
        `chat:new:${deployment.deploymentId}:${clientFingerprint(ip)}`,
        deployment.conversationsPerHour,
        3_600,
      );
    }

    let customer = existing?.customer;
    let status = existing?.status ?? 'open';
    // On resume the caller already holds a working token, so we hand back the
    // one they sent rather than issuing a second for the same conversation.
    let issuedToken = input.resume ?? '';

    if (!existing) {
      const opened = await this.visitors.openConversation(deployment, origin);
      customer = opened.conversation.customer;
      status = opened.conversation.status;
      issuedToken = opened.visitorToken;

      await this.audit.record(customer, {
        action: 'chat.conversation.open',
        resourceType: 'chat_conversation',
        resourceId: customer.conversationId,
        after: { deploymentId: deployment.deploymentId },
        requestId,
      });
    }

    const messages = existing ? await this.visitors.listMessagesForWidget(customer!) : [];

    return {
      visitorToken: issuedToken,
      chatbot: {
        name: chatbot.name,
        greeting: greetingFor(chatbot.greeting, chatbot.name),
        handoffEnabled: chatbot.handoffEnabled,
      },
      conversation: { status },
      messages,
    };
  }

  /** One conversational turn. */
  @Post('messages')
  async message(
    @Body() body: unknown,
    @Headers('origin') origin: string | undefined,
    @Headers('x-moka-key') publicKey: string | undefined,
    @Headers('x-moka-visitor') visitorToken: string | undefined,
    @Ip() ip: string,
    @RequestId() requestId: string,
  ) {
    const input = parse(messageSchema, body);
    const { deployment, customer, conversation, chatbot } = await this.authorize(
      publicKey,
      visitorToken,
      origin,
      requestId,
    );

    const valid = validateVisitorMessage(input.message);
    if (!valid.ok) throw new ValidationError({ message: valid.reason });

    this.visitors.assertWithinConversationBudget(conversation);

    // Two independent keys. The conversation limit stops one tab hammering;
    // the address limit stops a script opening a thousand conversations to
    // route around it.
    await enforceRateLimit(
      this.limiter,
      `chat:msg:${customer.conversationId}`,
      deployment.messagesPerMinute,
      60,
    );
    await enforceRateLimit(
      this.limiter,
      `chat:ip:${deployment.deploymentId}:${clientFingerprint(ip)}`,
      deployment.messagesPerMinute * 3,
      60,
    );

    // Recorded BEFORE the model runs, so a turn that fails or times out still
    // leaves the visitor's question in the transcript for whoever picks it up.
    await this.visitors.appendMessage(customer, {
      role: ChatRole.VISITOR,
      content: input.message,
    });

    const history = await this.visitors.listMessages(customer);
    const turn = await this.support.answer(customer, chatbot, {
      message: input.message,
      // Drop the message just written; it is passed separately as the request.
      history: history.slice(0, -1),
      requestId,
    });

    await this.visitors.appendMessage(customer, {
      role: ChatRole.ASSISTANT,
      content: turn.reply,
      citations: turn.citations,
      errorCode: turn.errorCode,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
    });

    return {
      reply: turn.reply,
      citations: turn.citations,
      grounded: turn.grounded,
      suggestHandoff: turn.suggestHandoff,
    };
  }

  /**
   * Ask for a person.
   *
   * A deterministic endpoint behind a button, NOT a tool the assistant decides
   * to call. Someone asking for a human is the one request that must not
   * depend on a model agreeing to it — and it is most often made by someone
   * the bot has just failed. Keeping it out of the tool set is also what lets
   * the customer tool set stay strictly read-only.
   */
  @Post('handoff')
  async handoff(
    @Headers('origin') origin: string | undefined,
    @Headers('x-moka-key') publicKey: string | undefined,
    @Headers('x-moka-visitor') visitorToken: string | undefined,
    @Ip() ip: string,
    @RequestId() requestId: string,
  ) {
    const { deployment, customer, chatbot } = await this.authorize(
      publicKey,
      visitorToken,
      origin,
      requestId,
    );

    if (!chatbot.handoffEnabled) {
      throw new ForbiddenError('Handoff is not enabled for this chatbot.');
    }

    // Tighter than the message limit: a handoff creates work for a person.
    await enforceRateLimit(
      this.limiter,
      `chat:handoff:${deployment.deploymentId}:${clientFingerprint(ip)}`,
      5,
      3_600,
    );

    await this.visitors.requestHandoff(customer);
    await this.visitors.appendMessage(customer, {
      role: ChatRole.NOTICE,
      content: 'The visitor asked to speak to a person.',
    });

    await this.audit.record(customer, {
      action: 'chat.handoff.request',
      resourceType: 'chat_conversation',
      resourceId: customer.conversationId,
      requestId,
    });

    return { ok: true };
  }

  /**
   * The common preamble for every authenticated-by-token route.
   *
   * The order is the security property: resolve the deployment first, then
   * check the origin, then find the conversation INSIDE the organization the
   * key resolved to. A token belonging to another tenant is never found,
   * rather than found and then rejected.
   */
  private async authorize(
    publicKey: string | undefined,
    visitorToken: string | undefined,
    origin: string | undefined,
    requestId: string,
  ) {
    if (!publicKey || !visitorToken) {
      throw new ForbiddenError('This conversation is no longer available.');
    }

    const deployment = await this.visitors.resolveDeployment(publicKey);
    this.visitors.assertOriginAllowed(deployment, origin, { requestId });

    const conversation = await this.visitors.resumeConversation(deployment, visitorToken);
    if (!conversation) {
      /*
       * Deliberately identical whether the token is expired, closed, invented,
       * or belongs to a different tenant. Distinguishing them would let a
       * prober sort real conversation tokens from noise.
       */
      throw new ForbiddenError('This conversation is no longer available.');
    }

    const chatbot = await this.visitors.loadChatbot(deployment);
    return { deployment, customer: conversation.customer, conversation, chatbot };
  }
}

/**
 * A short, salted-per-process digest of the caller's address, used only as a
 * rate-limit bucket key.
 *
 * The raw address is never stored and never leaves this function. It is a
 * throwaway grouping key, not a record of who visited — and it lives only in
 * the in-memory limiter, which forgets it when its window closes.
 */
const FINGERPRINT_SALT = createHash('sha256')
  .update(String(process.pid) + String(Date.now()))
  .digest('hex');

function clientFingerprint(ip: string): string {
  return createHash('sha256').update(`${FINGERPRINT_SALT}:${ip}`).digest('hex').slice(0, 16);
}

/** Re-exported for the module's own typing; not part of the public surface. */
export type { ResolvedDeployment };
