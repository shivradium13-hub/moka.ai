import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission, ValidationError, type TenantContext } from '@moka/core';
import { stripTenantKeys } from '@moka/tenancy';
import { AGENT_TEMPLATES, RiskLevel, findTemplate, toolCatalogue } from '@moka/agents';
import { AgentsService } from './agents.service.js';
import { AgentRunnerService } from './agent-runner.service.js';
import { CurrentTenant, RequestId, RequirePermission } from '../../common/decorators.js';

const idSchema = z.string().uuid();

const createAgentSchema = z.object({
  /**
   * Start from a pre-built template. Its instructions, ceiling and tools are
   * used as DEFAULTS — anything sent explicitly still wins, so a template is a
   * starting point rather than a locked configuration.
   */
  templateId: z.string().max(60).optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  instructions: z.string().max(20_000).default(''),
  permissionLevel: z.enum([RiskLevel.READ, RiskLevel.DRAFT, RiskLevel.EXECUTE]).optional(),
  tools: z.array(z.string().max(80)).max(40).optional(),
  maxSteps: z.number().int().min(1).max(50).optional(),
});

const runSchema = z.object({ message: z.string().min(1).max(20_000) });
const decisionSchema = z.object({ decision: z.enum(['approved', 'rejected']) });

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError({
      fields: result.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`),
    });
  }
  return result.data;
}

@Controller('v1/agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly runner: AgentRunnerService,
  ) {}

  /**
   * The tool catalogue for the agent builder.
   *
   * Unlike what is advertised to a MODEL, this deliberately includes risk,
   * permission and approval requirements: a human configuring an agent needs
   * to see exactly what they are granting.
   */
  @RequirePermission(Permission.PROJECT_READ)
  @Get('tools')
  async tools() {
    return { tools: toolCatalogue(this.runner.tools()) };
  }

  /**
   * Pre-built business agents (§25, §26).
   *
   * A template is a name, instructions, a risk ceiling and a tool allowlist,
   * and creating one from a template creates an ordinary agent row. It grants
   * nothing: an agent built from an official template passes through exactly
   * the same authorisation gates as one someone typed in by hand.
   *
   * `limitations` is returned and is never empty. A picker that lists six
   * capabilities and no limits sells a product that does not exist, and the
   * user finds out from a wrong answer instead of from us.
   */
  @RequirePermission(Permission.PROJECT_READ)
  @Get('templates')
  async templates() {
    return {
      templates: AGENT_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        summary: template.summary,
        limitations: template.limitations,
        permissionLevel: template.permissionLevel,
        tools: template.tools,
      })),
    };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get()
  async list(@CurrentTenant() tenant: TenantContext) {
    return { agents: await this.agents.list(tenant) };
  }

  @RequirePermission(Permission.PROJECT_CREATE)
  @Post()
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(createAgentSchema, stripTenantKeys((body ?? {}) as Record<string, unknown>));

    /*
     * A template supplies DEFAULTS, not a locked configuration. An explicit
     * value always wins, so a user who picked "Research assistant" and then
     * removed a tool gets the agent they configured.
     *
     * An unknown templateId is rejected rather than ignored: silently creating
     * an agent with no tools because a name was misspelled looks exactly like
     * a broken runtime the first time it is run.
     */
    const template = input.templateId ? findTemplate(input.templateId) : undefined;
    if (input.templateId && !template) {
      throw new ValidationError({ templateId: `Unknown template "${input.templateId}".` });
    }

    const resolved = {
      name: input.name,
      description: input.description ?? null,
      instructions: input.instructions || (template?.instructions ?? ''),
      permissionLevel: input.permissionLevel ?? template?.permissionLevel ?? RiskLevel.READ,
      tools: input.tools ?? template?.tools ?? [],
      ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    };

    return {
      agent: await this.agents.create(tenant, resolved, this.runner.tools(), { requestId }),
    };
  }

  @RequirePermission(Permission.PROJECT_DELETE)
  @Delete(':id')
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ) {
    await this.agents.remove(tenant, parse(idSchema, id), { requestId });
    return { ok: true };
  }

  /**
   * Run an agent.
   *
   * Requires only PROJECT_READ: the run's authority comes from the caller's
   * OWN role, checked per tool call at execution time. Gating the endpoint
   * itself on a high permission would be the wrong control — it would block
   * read-only use while doing nothing to constrain what a privileged caller's
   * agent may do.
   */
  @RequirePermission(Permission.PROJECT_READ)
  @Post(':id/run')
  async run(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const agentId = parse(idSchema, id);
    const input = parse(runSchema, body);
    const agent = await this.agents.get(tenant, agentId);

    return this.runner.run(
      tenant,
      {
        id: agent.id,
        name: agent.name,
        instructions: agent.instructions,
        permissionLevel: agent.permissionLevel as RiskLevel,
        allowlist: agent.tools,
        enabled: agent.status === 'active',
        maxSteps: agent.maxSteps,
        modelId: null,
      },
      { message: input.message, requestId },
    );
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('runs')
  async runs(@CurrentTenant() tenant: TenantContext) {
    return { runs: await this.agents.listRuns(tenant) };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('runs/:id/executions')
  async executions(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return { executions: await this.agents.listExecutions(tenant, parse(idSchema, id)) };
  }

  @RequirePermission(Permission.PROJECT_READ)
  @Get('approvals')
  async approvals(@CurrentTenant() tenant: TenantContext, @Query('status') status?: string) {
    const allowed = ['pending', 'approved', 'rejected', 'expired'];
    const filter = status && allowed.includes(status) ? status : 'pending';
    return { approvals: await this.agents.listApprovals(tenant, filter) };
  }

  /**
   * Decide a pending approval (§21).
   *
   * Gated on PROJECT_UPDATE at the route, and additionally on the specific
   * permission the gated tool requires — checked in the service, because only
   * it knows which tool the approval is for.
   */
  @RequirePermission(Permission.PROJECT_UPDATE)
  @Post('approvals/:id')
  async decide(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @RequestId() requestId: string,
  ) {
    const input = parse(decisionSchema, body);
    return {
      approval: await this.agents.decideApproval(
        tenant,
        parse(idSchema, id),
        input.decision,
        this.runner.tools(),
        { requestId },
      ),
    };
  }
}
