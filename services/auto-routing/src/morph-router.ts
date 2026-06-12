import * as z from 'zod';
import type {
  NormalizedClassifierInput,
  RouterDecision,
  RoutingContext,
} from '@kilocode/auto-routing-contracts';
import { ttlCached } from './ttl-cache';

// Morph's multimodel router classifies a prompt and picks the best model
// from an allowed set (https://docs.morphllm.com/sdk/components/router).
// One POST per decision, ~200ms typical.
export const MORPH_ROUTER_ENDPOINT = 'https://api.morphllm.com/v1/router/multimodel';

// Generous relative to Morph's ~200ms typical latency; decisions are
// shadow-mode today, so a slow call should fail the decision, not pile up
// against the gateway's background mirror budget.
const MORPH_ROUTER_TIMEOUT_MS = 5_000;

// The router only needs enough prompt to classify; matches the prefix caps
// the classifier already applies to mirrored input.
const ROUTER_INPUT_MAX_LENGTH = 1_000;

// Kilo public ids <-> Morph router catalog ids. Only models present in
// Morph's catalog can participate in a routed decision; unmapped candidates
// are dropped before the call (and reported via candidateCount telemetry).
const KILO_TO_MORPH_MODEL: Record<string, string> = {
  'anthropic/claude-opus-4.8': 'claude-opus-4-8',
  'anthropic/claude-sonnet-4.6': 'claude-sonnet-4-6',
  'anthropic/claude-haiku-4.5': 'claude-haiku-4-5-20251001',
  'openai/gpt-5.5': 'gpt-5.5',
  'google/gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'google/gemini-3.5-flash': 'gemini-3.5-flash',
  'deepseek/deepseek-v4-pro:discounted': 'deepseek-v4-pro',
  'deepseek/deepseek-v4-flash:discounted': 'deepseek-v4-flash',
};

const MORPH_TO_KILO_MODEL = new Map(
  Object.entries(KILO_TO_MORPH_MODEL).map(([kiloId, morphId]) => [morphId, kiloId])
);

// Tier intent -> router policy. Frontier never trades quality for cost;
// balanced lets the router break ties on cost; small hunts for the cheapest
// qualified model.
const AUTO_MODEL_POLICY: Record<string, string> = {
  'kilo-auto/frontier': 'capability_heavy',
  'kilo-auto/balanced': 'balanced',
  'kilo/auto': 'balanced',
  'kilo-auto/small': 'cost_efficient',
  'kilo-auto/free': 'cost_efficient',
};

const morphRouterResponseSchema = z.looseObject({
  model: z.string().trim().min(1),
  difficulty: z.string().optional(),
  confidence: z.number().optional(),
  ambiguity: z.string().optional(),
  ambiguity_confidence: z.number().optional(),
  domain: z.string().optional(),
  domain_confidence: z.number().optional(),
});

export type MorphRouterFailureStage = `http_${number}` | 'timeout' | 'fetch' | 'invalid_response';

export class MorphRouterError extends Error {
  readonly failureStage: MorphRouterFailureStage;

  constructor(message: string, failureStage: MorphRouterFailureStage) {
    super(message);
    this.name = 'MorphRouterError';
    this.failureStage = failureStage;
  }
}

export type MorphRouteSkipReason = 'no_prompt' | 'insufficient_candidates' | 'unknown_tier';

export type MorphRouteOutcome =
  | { kind: 'routed'; decision: RouterDecision; policy: string; candidateCount: number }
  | { kind: 'skipped'; reason: MorphRouteSkipReason };

type MorphRouterEnv = Pick<Env, 'MORPH_API_KEY'>;

// Same pattern as the OpenRouter key: cache the plain key string at module
// scope so each decision skips the secrets-store read, with a TTL that keeps
// rotations effective within five minutes.
const API_KEY_CACHE_TTL_MS = 300_000;

const apiKeyCache = ttlCached(API_KEY_CACHE_TTL_MS, (env: MorphRouterEnv) =>
  env.MORPH_API_KEY.get()
);

export function clearMorphApiKeyCache(): void {
  apiKeyCache.clear();
}

// The prompt the router classifies: the latest user turn when present (it
// redirects the current request), otherwise the opening turn. System prompts
// are agent boilerplate and would dominate the classification, so they are
// deliberately excluded — Morph receives at most one bounded user prompt
// prefix, never the conversation or tool results.
export function buildRouterInput(input: NormalizedClassifierInput): string | null {
  const prompt = input.latestUserPromptPrefix ?? input.userPromptPrefix;
  if (!prompt || prompt.trim().length === 0) return null;
  return prompt.slice(0, ROUTER_INPUT_MAX_LENGTH);
}

// The fingerprint scopes cached decisions to a specific candidate set and
// policy, so tier-membership or policy changes never serve stale models.
export function routerConfigFingerprint(routing: RoutingContext): string {
  const policy = AUTO_MODEL_POLICY[routing.autoModel] ?? 'unknown';
  const mapped = mappedCandidates(routing).map(candidate => candidate.morphId);
  return `${policy}:${[...mapped].sort().join(',')}`;
}

function mappedCandidates(routing: RoutingContext): Array<{ kiloId: string; morphId: string }> {
  const seen = new Set<string>();
  const candidates: Array<{ kiloId: string; morphId: string }> = [];
  for (const kiloId of routing.candidateModels) {
    const morphId = KILO_TO_MORPH_MODEL[kiloId];
    if (!morphId || seen.has(morphId)) continue;
    seen.add(morphId);
    candidates.push({ kiloId, morphId });
  }
  return candidates;
}

export async function routeWithMorphRouter(
  env: MorphRouterEnv,
  routing: RoutingContext,
  input: NormalizedClassifierInput
): Promise<MorphRouteOutcome> {
  const policy = AUTO_MODEL_POLICY[routing.autoModel];
  if (!policy) {
    return { kind: 'skipped', reason: 'unknown_tier' };
  }
  const routerInput = buildRouterInput(input);
  if (!routerInput) {
    return { kind: 'skipped', reason: 'no_prompt' };
  }
  const candidates = mappedCandidates(routing);
  // With fewer than two routable models there is no decision to make.
  if (candidates.length < 2) {
    return { kind: 'skipped', reason: 'insufficient_candidates' };
  }

  const resolvedCandidate = candidates.find(
    candidate => candidate.kiloId === routing.resolvedModel
  );
  // When the prompt is too ambiguous to size, the router returns
  // default_model as-is; the static resolver's pick keeps that case
  // behavior-identical to routing without Morph.
  const defaultModel = (resolvedCandidate ?? candidates[0]).morphId;

  const response = await morphRouterFetch(env, {
    input: routerInput,
    allowed_models: candidates.map(candidate => candidate.morphId),
    policy,
    default_model: defaultModel,
  });

  const kiloModel = MORPH_TO_KILO_MODEL.get(response.model);
  // Candidates were sent as allowed_models, so anything else back means the
  // router ignored the allow-list; never serve a model the tier doesn't own.
  if (!kiloModel || !candidates.some(candidate => candidate.kiloId === kiloModel)) {
    throw new MorphRouterError(
      `Morph router returned a model outside the allowed candidates`,
      'invalid_response'
    );
  }

  return {
    kind: 'routed',
    policy,
    candidateCount: candidates.length,
    decision: {
      source: 'morph_router',
      model: kiloModel,
      routerModel: response.model,
      difficulty: response.difficulty ?? null,
      confidence: response.confidence ?? null,
      ambiguity: response.ambiguity ?? null,
      domain: response.domain ?? null,
    },
  };
}

async function morphRouterFetch(
  env: MorphRouterEnv,
  body: Record<string, unknown>
): Promise<z.infer<typeof morphRouterResponseSchema>> {
  const apiKey = await apiKeyCache.get(env);
  let response: Response;
  try {
    response = await fetch(MORPH_ROUTER_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MORPH_ROUTER_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
    throw new MorphRouterError(
      isTimeout ? 'Morph router request timed out' : 'Morph router request failed',
      isTimeout ? 'timeout' : 'fetch'
    );
  }
  if (!response.ok) {
    throw new MorphRouterError(
      `Morph router returned ${response.status}`,
      `http_${response.status}`
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new MorphRouterError('Morph router returned invalid JSON', 'invalid_response');
  }
  const parsed = morphRouterResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new MorphRouterError('Morph router returned an unexpected shape', 'invalid_response');
  }
  return parsed.data;
}
