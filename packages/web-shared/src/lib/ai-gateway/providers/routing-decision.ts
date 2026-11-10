import * as z from 'zod';
import {
  EnkryptGuardrailReportSchema,
  EnkryptOutputGuardrailReportSchema,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import {
  UserByokProviderIdSchema,
  type UserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  GatewayChatApiKindSchema,
  ProviderTypeSchema,
  type ProviderType,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getByokKeyDefaultRank } from '@kilocode/web-shared/lib/ai-gateway/byok/route-order';
import type { KeyPlanStep } from '@kilocode/web-shared/lib/ai-gateway/providers/route-plan';

const ByokCandidateRouteSchema = z.enum(['direct-byok', 'vercel-byok', 'gateway-byok']);

const ByokCandidateSkipReasonSchema = z.enum([
  'unsupported-api-kind',
  'disabled',
  'not-catalog-mode',
  'model-unavailable',
  'provider-settings',
  'ignored-by-request',
]);

export type ByokCandidateSkipReason = z.infer<typeof ByokCandidateSkipReasonSchema>;

const RoutingDecisionByokCandidateSchema = z.object({
  route: ByokCandidateRouteSchema,
  provider_id: UserByokProviderIdSchema,
  /** The owner's chosen priority, or null when the key keeps its default order. */
  priority: z.number().nullable(),
  default_rank: z.number(),
  /** The key's position in the owner's whole key list, which orders the candidates. */
  route_order: z.number(),
  outcome: z.enum(['selected', 'skipped', 'unreached']),
  /**
   * Why the key was skipped. On a selected key, why it was used only as a fallback: the request
   * ignores its provider, or it does not serve the API kind and the request fails with that error.
   */
  reason: ByokCandidateSkipReasonSchema.optional(),
});

type RoutingDecisionByokCandidate = z.infer<typeof RoutingDecisionByokCandidateSchema>;

const CustomLlmVisibilitySchema = z.enum(['public', 'private']);

/**
 * Steps in the order `getProvider` took them, ending at the one that decided the result. The local
 * fake LLM and organization policy steps are listed only when they applied.
 */
const RoutingDecisionStepSchema = z.union([
  z.object({ step: z.literal('local-fake-llm'), outcome: z.literal('selected') }),
  z.object({
    step: z.literal('custom-llm'),
    outcome: z.literal('skipped'),
    reason: z.literal('no-match'),
  }),
  z.object({
    step: z.literal('custom-llm'),
    outcome: z.literal('selected'),
    visibility: CustomLlmVisibilitySchema,
  }),
  z.object({
    step: z.literal('custom-llm'),
    outcome: z.literal('rejected'),
    visibility: CustomLlmVisibilitySchema,
    reason: z.enum(['country-denied', 'not-eligible', 'invalid-credentials']),
  }),
  z.object({
    step: z.literal('direct-byok-model'),
    outcome: z.literal('skipped'),
    reason: z.literal('no-match'),
  }),
  z.object({
    step: z.literal('direct-byok-model'),
    outcome: z.literal('skipped'),
    provider_id: z.string(),
    reason: z.literal('no-key'),
  }),
  z.object({
    step: z.literal('direct-byok-model'),
    outcome: z.literal('selected'),
    provider_id: z.string(),
  }),
  z.object({
    step: z.literal('direct-byok-model'),
    outcome: z.literal('rejected'),
    provider_id: z.string(),
    reason: z.literal('catalog-only'),
    catalog_model_id: z.string().nullable(),
  }),
  z.object({ step: z.literal('organization-policy'), excluded_provider_ids: z.array(z.string()) }),
  z.object({ step: z.literal('chatgpt'), outcome: z.literal('selected') }),
  z.object({
    step: z.literal('chatgpt'),
    outcome: z.literal('rejected'),
    reason: z.literal('reconnect'),
  }),
  z.object({
    step: z.literal('chatgpt'),
    outcome: z.literal('skipped'),
    reason: z.literal('unavailable'),
  }),
  /** A catalog-mode key that serves ranks above the connection, so it is not checked. */
  z.object({
    step: z.literal('chatgpt'),
    outcome: z.literal('deferred'),
    reason: z.literal('catalog-key-serves'),
  }),
  z.object({ step: z.literal('claude-billing'), outcome: z.literal('selected') }),
  z.object({
    step: z.literal('claude-billing'),
    outcome: z.literal('rejected'),
    reason: z.literal('unavailable'),
  }),
  z.object({
    step: z.literal('claude-billing'),
    outcome: z.literal('skipped'),
    reason: z.literal('unavailable'),
  }),
  z.object({
    step: z.literal('byok-key'),
    outcome: z.literal('selected'),
    route: ByokCandidateRouteSchema,
    provider_id: UserByokProviderIdSchema,
  }),
  z.object({
    step: z.literal('byok-key'),
    outcome: z.literal('skipped'),
    reason: z.enum(['no-candidates', 'none-served']),
  }),
  z.object({
    step: z.literal('unsupported-api-kind'),
    outcome: z.literal('selected'),
    provider_id: UserByokProviderIdSchema,
    supported_api_kinds: z.array(GatewayChatApiKindSchema),
  }),
  z.object({
    step: z.literal('kilo'),
    outcome: z.literal('selected'),
    gateway: z.enum(['vercel', 'openrouter']),
    bounded_spending: z.boolean(),
    organization_disabled_vercel_ai_gateway: z.boolean(),
    kilo_ignored_providers: z.array(z.string()),
  }),
]);

export type RoutingDecisionStep = z.infer<typeof RoutingDecisionStepSchema>;

const SelectedRouteSchema = z.enum([
  'local-fake-llm',
  'custom-llm',
  'direct-byok-model',
  'chatgpt',
  'claude-billing',
  ...ByokCandidateRouteSchema.options,
  'unsupported-api-kind',
  'kilo',
]);

type SelectedRoute = z.infer<typeof SelectedRouteSchema>;

/** Whose account the upstream provider bills. */
const PayerSchema = z.enum([
  'none',
  'custom-llm-credential',
  'owner-byok-key',
  'chatgpt-subscription',
  'customer-claude-organization',
  'kilo',
]);

type Payer = z.infer<typeof PayerSchema>;

const RoutingDecisionResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider'),
    route: SelectedRouteSchema.nullable(),
    provider_type: ProviderTypeSchema,
    byok_provider_ids: z.array(UserByokProviderIdSchema),
    payer: PayerSchema.nullable(),
    is_free: z.boolean(),
  }),
  z.object({
    kind: z.enum([
      'chatgpt-reconnect',
      'claude-billing-unavailable',
      'custom-llm-unavailable',
      'direct-byok-catalog-only',
    ]),
  }),
]);

type RoutingDecisionResult = z.infer<typeof RoutingDecisionResultSchema>;

const ProviderRoutingDecisionSchema = z.object({
  requested_model: z.string(),
  api_kind: GatewayChatApiKindSchema,
  owner_type: z.enum(['user', 'organization', 'anonymous']),
  steps: z.array(RoutingDecisionStepSchema),
  byok_candidates: z.array(RoutingDecisionByokCandidateSchema),
  result: RoutingDecisionResultSchema,
});

export type ProviderRoutingDecision = z.infer<typeof ProviderRoutingDecisionSchema>;

/** A `<usage_id>.json` object in the AI provider metadata bucket. */
export const KiloRoutingDecisionRecordSchema = ProviderRoutingDecisionSchema.extend({
  schema_version: z.literal(1),
  /** The `microdollar_usage` and `microdollar_usage_metadata` id of the request. */
  usage_id: z.uuid(),
  created_at: z.iso.datetime(),
  vercel: z
    .object({
      metadata: z.record(z.string(), z.unknown()),
    })
    .optional(),
  /** The organization's Enkrypt input guardrail, when it applied to the request. */
  enkrypt: EnkryptGuardrailReportSchema.optional(),
  /** The organization's Enkrypt output guardrail, when it applied to the response. */
  enkrypt_output: EnkryptOutputGuardrailReportSchema.optional(),
});

export type KiloRoutingDecisionRecord = z.infer<typeof KiloRoutingDecisionRecordSchema>;

/** The parts of a `getProvider` result the decision reports. */
type DecidedProviderResult =
  | {
      kind: 'provider';
      provider: { type: ProviderType };
      userByok: { providerId: UserByokProviderId }[] | null;
      isFree: boolean;
    }
  | Exclude<RoutingDecisionResult, { kind: 'provider' }>;

type SelectedStep = Extract<RoutingDecisionStep, { outcome: 'selected' }>;

function isSelectedStep(step: RoutingDecisionStep): step is SelectedStep {
  return 'outcome' in step && step.outcome === 'selected';
}

function selectedRouteOf(step: SelectedStep): SelectedRoute {
  return step.step === 'byok-key' ? step.route : step.step;
}

function payerOf(route: SelectedRoute): Payer {
  switch (route) {
    case 'local-fake-llm':
      return 'none';
    case 'custom-llm':
      return 'custom-llm-credential';
    case 'chatgpt':
      return 'chatgpt-subscription';
    case 'claude-billing':
      return 'customer-claude-organization';
    case 'kilo':
      return 'kilo';
    case 'direct-byok-model':
    case 'direct-byok':
    case 'vercel-byok':
    case 'gateway-byok':
    case 'unsupported-api-kind':
      return 'owner-byok-key';
  }
}

/**
 * Collects the steps and BYOK candidates of one `getProvider` call. It holds provider and route
 * identifiers only, never key material, credentials, or request content.
 */
export function createRoutingDecisionRecorder(
  request: Pick<ProviderRoutingDecision, 'requested_model' | 'api_kind' | 'owner_type'>
) {
  const steps: RoutingDecisionStep[] = [];
  let keySteps: KeyPlanStep[] = [];
  let candidates: RoutingDecisionByokCandidate[] = [];

  return {
    step(step: RoutingDecisionStep) {
      steps.push(step);
    },
    /** Lists the key steps of the route plan as candidates, none reached yet. */
    recordByokCandidates(planKeySteps: readonly KeyPlanStep[]) {
      keySteps = [...planKeySteps];
      candidates = keySteps.map(({ route, key, routeOrder }) => ({
        route,
        provider_id: key.providerId,
        priority: key.priority ?? null,
        default_rank: getByokKeyDefaultRank(key.providerId),
        route_order: routeOrder,
        outcome: 'unreached',
      }));
    },
    /** A selected key keeps the reason it was skipped at its own rank. */
    markByokCandidate(
      step: KeyPlanStep,
      outcome: RoutingDecisionByokCandidate['outcome'],
      reason?: ByokCandidateSkipReason
    ) {
      const index = keySteps.indexOf(step);
      const candidate = candidates[index];
      if (!candidate) return;
      candidates[index] = { ...candidate, outcome, ...(reason ? { reason } : {}) };
    },
    finish(result: DecidedProviderResult): ProviderRoutingDecision {
      let decisionResult: RoutingDecisionResult;
      if (result.kind === 'provider') {
        const selected = steps.findLast(isSelectedStep);
        const route = selected ? selectedRouteOf(selected) : null;
        decisionResult = {
          kind: 'provider',
          route,
          provider_type: result.provider.type,
          byok_provider_ids: result.userByok?.map(byok => byok.providerId) ?? [],
          payer: route ? payerOf(route) : null,
          is_free: result.isFree,
        };
      } else {
        decisionResult = { kind: result.kind };
      }
      return { ...request, steps, byok_candidates: candidates, result: decisionResult };
    },
  };
}

export type RoutingDecisionRecorder = ReturnType<typeof createRoutingDecisionRecorder>;
