import { RiskLevel, type ToolDefinition } from './tool.js';

/**
 * Business agent templates (master prompt §25, §26).
 *
 * WHAT A TEMPLATE IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * A template is a NAME, INSTRUCTIONS, A RISK CEILING AND A TOOL ALLOWLIST.
 * That is the whole of it. It creates an ordinary agent row and nothing else:
 * no new subsystem, no privileged path, no capability that is not already in
 * the registry. §26 requires that marketplace agents pass the identical gate,
 * and the cheapest way to guarantee that is for there to be no other gate — a
 * template built by us goes through `authorizeToolCall` exactly like one a
 * user typed in by hand.
 *
 * WHY THE LIST IS SHORTER THAN THE BRIEF'S
 *
 * The brief names sales, analytics, website, marketing, social and research
 * agents. A template can only be honest about tools that exist, so:
 *
 *   - There is no CRM, so a "sales agent" that claims to read a pipeline would
 *     be a lie. The sales template researches a prospect and DRAFTS an
 *     approach, which is a genuinely useful thing built from real tools.
 *   - There is no analytics integration, so the analytics template reports on
 *     THIS workspace — projects, knowledge, agent activity — and its name and
 *     description say so rather than implying Google Analytics.
 *   - There is no social publishing, and nothing here can post anything. The
 *     social template drafts copy. Its instructions say plainly that it cannot
 *     publish, because a model claiming to have posted something is the exact
 *     failure that would embarrass a user in public.
 *
 * A template naming a tool that does not exist, or exceeding its own ceiling,
 * is a bug that `validateTemplates` turns into a failing test rather than a
 * confusing runtime denial.
 */

export interface AgentTemplate {
  readonly id: string;
  readonly name: string;
  /** One line, shown in the picker. */
  readonly summary: string;
  /**
   * What this agent genuinely cannot do, in the user's terms.
   *
   * Present on every template and never empty. A picker that lists six
   * capabilities and no limits sells a product that does not exist, and the
   * user finds out from a wrong answer rather than from us.
   */
  readonly limitations: readonly string[];
  readonly instructions: string;
  readonly permissionLevel: RiskLevel;
  readonly tools: readonly string[];
}

/** Shared preamble. Operator instructions follow it, so it is a floor. */
const HOUSE_RULES = [
  'Work only from what your tools return. If they do not answer the question,',
  'say what is missing rather than filling the gap from memory.',
  '',
  'Never claim to have done something you have not done. You cannot send email,',
  'publish anything, contact anyone, or change a system outside this workspace.',
  'If a task needs one of those, produce the draft and say who needs to act.',
].join('\n');

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: 'research',
    name: 'Research assistant',
    summary: 'Reads web pages you name, or searches if an engine is configured, and answers with citations.',
    limitations: [
      'Every source is a page it actually fetched — it cannot cite anything it could not read.',
      'Without a search engine configured, you supply the URLs to read.',
      'It respects robots.txt, so some pages will be skipped.',
    ],
    instructions: [
      'You are a research assistant. Answer questions using the web_research tool.',
      '',
      'Report what the sources say, and where they disagree, say so rather than',
      'picking one. If the sources do not cover the question, say that plainly —',
      'it is a useful answer and a guess is not.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    permissionLevel: RiskLevel.READ,
    tools: ['web_research', 'search_knowledge'],
  },
  {
    id: 'website',
    name: 'Website analyst',
    summary: 'Reads a site you have indexed and answers questions about what it actually says.',
    limitations: [
      'It reads your site; it cannot edit or publish anything.',
      'It only sees pages that were successfully crawled and indexed.',
    ],
    instructions: [
      'You answer questions about the content of a website that has been indexed',
      'into this workspace. Quote the page you are drawing on.',
      '',
      'When asked to improve something, produce the suggested wording. You cannot',
      'change the site, and saying you have would be false.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    permissionLevel: RiskLevel.READ,
    tools: ['search_knowledge', 'list_knowledge_sources'],
  },
  {
    id: 'sales',
    name: 'Sales research assistant',
    summary: 'Researches a prospect from public pages and drafts an approach.',
    limitations: [
      'It is not connected to a CRM and cannot see your pipeline, contacts or deals.',
      'It drafts outreach; it cannot send anything.',
    ],
    instructions: [
      'You help prepare for a sales conversation. Given a company or a page,',
      'research what they do publicly and draft a short, specific approach.',
      '',
      'Ground every claim about the prospect in something you actually read.',
      'A confident wrong detail about someone’s business is worse than a short',
      'note, because it will be said out loud to them.',
      '',
      'You have no access to a CRM, a pipeline or contact records. If asked about',
      'those, say so.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    permissionLevel: RiskLevel.READ,
    tools: ['web_research', 'search_knowledge'],
  },
  {
    id: 'marketing',
    name: 'Marketing writer',
    summary: 'Drafts copy grounded in your own knowledge base and in pages it can read.',
    limitations: [
      'Everything it produces is a draft for a person to review and publish.',
      'It cannot post, schedule or send anything.',
    ],
    instructions: [
      'You draft marketing copy. Ground product claims in the knowledge base or',
      'in a page you read — an invented feature or an invented number becomes a',
      'public statement the company has to stand behind.',
      '',
      'Mark anything you could not verify so a reviewer can check it.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    permissionLevel: RiskLevel.READ,
    tools: ['search_knowledge', 'web_research', 'list_knowledge_sources'],
  },
  {
    id: 'social',
    name: 'Social drafter',
    summary: 'Turns a source into short posts. Drafts only — nothing is published.',
    limitations: [
      'It cannot publish, schedule or post to any platform. There is no integration.',
      'A person copies the draft and posts it themselves.',
    ],
    instructions: [
      'You draft short social posts from material in this workspace.',
      '',
      'You cannot publish anything and there is no scheduling integration. Never',
      'say a post has been scheduled or published — a user acting on that would',
      'find out from the silence.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    permissionLevel: RiskLevel.READ,
    tools: ['search_knowledge'],
  },
  {
    id: 'workspace-analyst',
    name: 'Workspace analyst',
    summary: 'Answers questions about this workspace: its projects and knowledge sources.',
    limitations: [
      'It reports on THIS workspace only. It is not connected to Google Analytics,',
      'a product database, or any external analytics tool.',
      'It reads; it does not change anything.',
    ],
    instructions: [
      'You answer questions about the state of this workspace — what projects',
      'exist and what knowledge has been indexed.',
      '',
      'You have no connection to any external analytics or business system. If',
      'asked about website traffic, revenue or customer data, say that plainly',
      'rather than estimating.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    permissionLevel: RiskLevel.READ,
    tools: ['list_projects', 'list_knowledge_sources', 'search_knowledge'],
  },
  {
    id: 'project-assistant',
    name: 'Project assistant',
    summary: 'Reads and creates projects on your behalf. The only template that writes anything.',
    limitations: [
      'It can create projects. It cannot delete one.',
      'It only ever acts with your own permissions — if you cannot create a',
      'project, neither can it.',
    ],
    instructions: [
      'You help manage projects in this workspace. Confirm what you are about to',
      'create before creating it, and describe what exists rather than guessing.',
      '',
      HOUSE_RULES,
    ].join('\n'),
    // The only template above READ. Deliberately DRAFT and not EXECUTE: nothing
    // in the list is destructive, and a ceiling that permits more than the
    // tools need is a ceiling that stops meaning anything.
    permissionLevel: RiskLevel.DRAFT,
    tools: ['list_projects', 'get_project', 'create_project', 'search_knowledge'],
  },
];

export function findTemplate(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((template) => template.id === id);
}

export interface TemplateProblem {
  readonly templateId: string;
  readonly problem: string;
}

/**
 * Check every template against the live registry.
 *
 * Run as a unit test, so a template naming a tool that has been renamed fails
 * in CI rather than becoming a confusing runtime denial for a user who chose
 * something from a picker and got "this agent is not permitted to use that
 * tool" on their first message.
 *
 * The ceiling check catches the subtler mistake: a template whose declared
 * risk level is below a tool it lists would create an agent that can never
 * call that tool, which looks exactly like a bug in the runtime.
 */
export function validateTemplates(
  registry: ReadonlyMap<string, ToolDefinition>,
  templates: readonly AgentTemplate[] = AGENT_TEMPLATES,
): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const rank: Record<RiskLevel, number> = {
    [RiskLevel.READ]: 0,
    [RiskLevel.DRAFT]: 1,
    [RiskLevel.EXECUTE]: 2,
  };

  const seen = new Set<string>();

  for (const template of templates) {
    if (seen.has(template.id)) {
      problems.push({ templateId: template.id, problem: 'duplicate template id' });
    }
    seen.add(template.id);

    if (template.limitations.length === 0) {
      problems.push({
        templateId: template.id,
        problem: 'no limitations listed; every template must say what it cannot do',
      });
    }

    for (const toolName of template.tools) {
      const tool = registry.get(toolName);
      if (!tool) {
        problems.push({ templateId: template.id, problem: `unknown tool "${toolName}"` });
        continue;
      }
      if (rank[tool.risk] > rank[template.permissionLevel]) {
        problems.push({
          templateId: template.id,
          problem: `tool "${toolName}" has risk ${tool.risk}, above the template ceiling ${template.permissionLevel}`,
        });
      }
    }
  }

  return problems;
}
