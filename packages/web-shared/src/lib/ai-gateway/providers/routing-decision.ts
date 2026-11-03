import type { GetProviderResult } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  GatewayChatApiKind,
  ProviderType,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export type ByokCandidateRoute = 'direct-byok' | 'vercel-byok' | 'gateway-byok';

export type ByokCandidateSkipReason =
  | 'unsupported-api-kind'
  | 'disabled'
  | 'not-catalog-mode'
  | 'model-unavailable'
  | 'provider-settings'
  | 'ignored-by-request'
  | 'not-loaded';

export type RoutingDecisionByokCandidate = {
  route: ByokCandidateRoute;
  provider_id: UserByokProviderId;
  /** The owner's chosen priority, or null when the key keeps its default order. */
  priority: number | null;
  default_rank: number;
  /** The key's position in the owner's whole key list, which orders the candidates. */
  route_order: number;
  outcome: 'selected' | 'skipped' | 'unreached';
  /** Why the key was skipped. On a selected key, the request preference it was used despite. */
  reason?: ByokCandidateSkipReason;
};

/**
 * Steps in the order `getProvider` took them, ending at the one that decided the result. The local
 * fake LLM and organization policy steps are listed only when they applied.
 */
export type RoutingDecisionStep =
  | { step: 'local-fake-llm'; outcome: 'selected' }
  | { step: 'custom-llm'; outcome: 'skipped'; reason: 'no-match' }
  | { step: 'custom-llm'; outcome: 'selected'; visibility: CustomLlmVisibility }
  | {
      step: 'custom-llm';
      outcome: 'rejected';
      visibility: CustomLlmVisibility;
      reason: 'country-denied' | 'not-eligible' | 'invalid-credentials';
    }
  | { step: 'direct-byok-model'; outcome: 'skipped'; reason: 'no-match' }
  | { step: 'direct-byok-model'; outcome: 'skipped'; provider_id: string; reason: 'no-key' }
  | { step: 'direct-byok-model'; outcome: 'selected'; provider_id: string }
  | {
      step: 'direct-byok-model';
      outcome: 'rejected';
      provider_id: string;
      reason: 'catalog-only';
      catalog_model_id: string | null;
    }
  | { step: 'organization-policy'; excluded_provider_ids: string[] }
  | { step: 'chatgpt'; outcome: 'selected' }
  | { step: 'chatgpt'; outcome: 'rejected'; reason: 'reconnect' }
  | { step: 'chatgpt'; outcome: 'skipped'; reason: 'unavailable' }
  | { step: 'chatgpt'; outcome: 'deferred'; reason: 'catalog-key-serves' }
  | {
      step: 'byok-key';
      outcome: 'selected';
      route: ByokCandidateRoute;
      provider_id: UserByokProviderId;
    }
  | { step: 'byok-key'; outcome: 'skipped'; reason: 'no-candidates' | 'none-served' }
  | {
      step: 'unsupported-api-kind';
      outcome: 'selected';
      provider_id: UserByokProviderId;
      supported_api_kinds: GatewayChatApiKind[];
    }
  | {
      step: 'unsupported-api-kind';
      outcome: 'skipped';
      provider_id: UserByokProviderId;
      supported_api_kinds: GatewayChatApiKind[];
      reason: 'not-loaded';
    }
  | {
      step: 'kilo';
      outcome: 'selected';
      gateway: 'vercel' | 'openrouter';
      bounded_spending: boolean;
      kilo_ignored_providers: string[];
    };

type CustomLlmVisibility = 'public' | 'private';

type SelectedRoute =
  | 'local-fake-llm'
  | 'custom-llm'
  | 'direct-byok-model'
  | 'chatgpt'
  | ByokCandidateRoute
  | 'unsupported-api-kind'
  | 'kilo';

/** Whose account the upstream provider bills. */
type Payer = 'none' | 'custom-llm-credential' | 'owner-byok-key' | 'chatgpt-subscription' | 'kilo';

export type RoutingDecisionResult =
  | {
      kind: 'provider';
      route: SelectedRoute | null;
      provider_type: ProviderType;
      byok_provider_ids: UserByokProviderId[];
      payer: Payer | null;
      is_free: boolean;
    }
  | { kind: Exclude<GetProviderResult['kind'], 'provider'> };

export type ProviderRoutingDecision = {
  requested_model: string;
  api_kind: GatewayChatApiKind;
  owner_type: 'user' | 'organization' | 'anonymous';
  steps: RoutingDecisionStep[];
  byok_candidates: RoutingDecisionByokCandidate[];
  result: RoutingDecisionResult;
};

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
  let candidates: RoutingDecisionByokCandidate[] = [];

  return {
    step(step: RoutingDecisionStep) {
      steps.push(step);
    },
    rankByokCandidates(ranked: RoutingDecisionByokCandidate[]) {
      candidates = ranked;
    },
    markByokCandidate(
      index: number,
      outcome: RoutingDecisionByokCandidate['outcome'],
      reason?: ByokCandidateSkipReason
    ) {
      const candidate = candidates[index];
      if (!candidate) return;
      candidates[index] = { ...candidate, outcome, ...(reason ? { reason } : {}) };
      if (outcome === 'selected') {
        steps.push({
          step: 'byok-key',
          outcome,
          route: candidate.route,
          provider_id: candidate.provider_id,
        });
      }
    },
    finish(result: GetProviderResult): ProviderRoutingDecision {
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
