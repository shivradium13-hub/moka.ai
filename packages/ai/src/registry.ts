import { Capability, type ModelDescriptor } from './types.js';

/**
 * Model registry (docs/architecture.md §17).
 *
 * A CODE registry rather than a database table: model capabilities are
 * behavioural facts that the router and adapters must agree on, and a row an
 * operator can edit to claim a model supports vision when it does not is a
 * source of confusing failures. Per-organization enablement and BYOK live in
 * the database; what a model *is* lives here.
 *
 * ON PRICING
 * Anthropic figures are taken from the bundled `claude-api` reference and are
 * dated. OpenAI and Google pricing could not be verified in this environment,
 * so those models carry `pricing: null` and their cost is reported as UNKNOWN
 * rather than estimated. Token counts are still tracked in full. Inventing a
 * dollar figure would put a number people budget against behind a guess (§45).
 */

const ANTHROPIC_PRICING_SOURCE = 'Anthropic claude-api skill reference';
const ANTHROPIC_PRICING_DATE = '2026-06-24';

function anthropicModel(params: {
  id: string;
  displayName: string;
  capabilities: readonly Capability[];
  contextWindow: number;
  inputPerMillion: number;
  outputPerMillion: number;
  routingPriority: number;
  maxOutputTokens?: number;
}): ModelDescriptor {
  return {
    id: params.id,
    providerId: 'anthropic',
    displayName: params.displayName,
    capabilities: params.capabilities,
    contextWindow: params.contextWindow,
    maxOutputTokens: params.maxOutputTokens ?? 64_000,
    pricing: {
      inputPerMillion: params.inputPerMillion,
      outputPerMillion: params.outputPerMillion,
      source: ANTHROPIC_PRICING_SOURCE,
      verifiedOn: ANTHROPIC_PRICING_DATE,
    },
    routingPriority: params.routingPriority,
    status: 'available',
  };
}

/** Pricing deliberately unknown — see the note above. */
function unpricedModel(params: {
  id: string;
  providerId: string;
  displayName: string;
  capabilities: readonly Capability[];
  contextWindow: number;
  maxOutputTokens: number;
  routingPriority: number;
}): ModelDescriptor {
  return { ...params, pricing: null, status: 'available' };
}

const FULL = [
  Capability.TEXT,
  Capability.VISION,
  Capability.TOOLS,
  Capability.REASONING,
  Capability.LONG_CONTEXT,
] as const;

export const MODELS: readonly ModelDescriptor[] = [
  // --- Anthropic -----------------------------------------------------------
  anthropicModel({
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    capabilities: FULL,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 5,
    outputPerMillion: 25,
    // The documented default for general work.
    routingPriority: 10,
  }),
  anthropicModel({
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    capabilities: FULL,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 2,
    outputPerMillion: 10,
    routingPriority: 20,
  }),
  anthropicModel({
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    capabilities: [Capability.TEXT, Capability.VISION, Capability.TOOLS, Capability.FAST, Capability.CHEAP],
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPerMillion: 1,
    outputPerMillion: 5,
    routingPriority: 30,
  }),
  anthropicModel({
    id: 'claude-fable-5-1',
    displayName: 'Claude Fable 5.1',
    capabilities: FULL,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 10,
    outputPerMillion: 50,
    // Most capable, most expensive: chosen only when asked for explicitly.
    routingPriority: 5,
  }),
  anthropicModel({
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    capabilities: FULL,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputPerMillion: 5,
    outputPerMillion: 25,
    routingPriority: 15,
  }),

  // --- OpenAI (pricing unverified in this build) ----------------------------
  unpricedModel({
    id: 'gpt-4o',
    providerId: 'openai',
    displayName: 'GPT-4o',
    capabilities: [Capability.TEXT, Capability.VISION, Capability.TOOLS],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    routingPriority: 40,
  }),
  unpricedModel({
    id: 'gpt-4o-mini',
    providerId: 'openai',
    displayName: 'GPT-4o mini',
    capabilities: [Capability.TEXT, Capability.VISION, Capability.TOOLS, Capability.FAST, Capability.CHEAP],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    routingPriority: 50,
  }),

  // --- Google (pricing unverified in this build) ----------------------------
  unpricedModel({
    id: 'gemini-2.0-flash',
    providerId: 'google',
    displayName: 'Gemini 2.0 Flash',
    capabilities: [Capability.TEXT, Capability.VISION, Capability.TOOLS, Capability.FAST, Capability.LONG_CONTEXT],
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    routingPriority: 45,
  }),
];

const BY_ID = new Map(MODELS.map((model) => [model.id, model]));

export function findModel(modelId: string): ModelDescriptor | null {
  return BY_ID.get(modelId) ?? null;
}

export function listModels(options: { providerId?: string } = {}): readonly ModelDescriptor[] {
  return MODELS.filter(
    (model) =>
      model.status === 'available' &&
      (!options.providerId || model.providerId === options.providerId),
  );
}

export function modelsWithCapabilities(
  required: readonly Capability[],
): readonly ModelDescriptor[] {
  return listModels()
    .filter((model) => required.every((capability) => model.capabilities.includes(capability)))
    .toSorted((a, b) => a.routingPriority - b.routingPriority);
}

/** The registry's default when a caller expresses no preference. */
export const DEFAULT_MODEL_ID = 'claude-opus-5';
