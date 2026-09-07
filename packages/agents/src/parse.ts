import type { ModelStep } from './runtime.js';

/**
 * Interpret a model reply as either a tool call or a final message.
 *
 * CONSERVATIVE BY DESIGN. Anything that is not unambiguously a well-formed
 * tool-call object is treated as TEXT. Guessing at a malformed call would mean
 * inventing arguments for a privileged operation, which is exactly the thing
 * that must never be improvised — and a model that produces half a tool call
 * is a model whose intent we do not actually know.
 *
 * Tool calling is expressed as a JSON convention rather than native provider
 * tool-use because the gateway's `chat` is deliberately provider-agnostic.
 * Native per-provider tool-use is Phase 5b.
 *
 * NOT VERIFIED against a live provider: no API key exists in this environment
 * (docs/roadmap.md §B). It follows the documented contract but has only ever
 * run against scripted input.
 *
 * Lives in the agents package rather than beside one of its callers: both the
 * staff runner and the public chatbot parse model replies, and a pure function
 * two NestJS modules import from each other's service files is how import
 * cycles get built.
 */
export function parseModelStep(text: string): ModelStep {
  const trimmed = text.trim();
  const candidate = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim()
    : trimmed;

  if (!candidate.startsWith('{')) return { type: 'message', text };

  try {
    const parsed: unknown = JSON.parse(candidate);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { tool?: unknown }).tool === 'string'
    ) {
      const call = parsed as { tool: string; input?: unknown; rationale?: unknown };
      return {
        type: 'tool_call',
        toolName: call.tool,
        input: call.input ?? {},
        ...(typeof call.rationale === 'string' ? { rationale: call.rationale } : {}),
      };
    }
  } catch {
    // Not JSON. Fall through and treat it as prose.
  }

  return { type: 'message', text };
}
