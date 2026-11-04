import { after, type NextResponse } from 'next/server';
import {
  AUTO_DECISION_HEADER,
  customRouterModelId,
  isCustomRouterModelId,
  type AutoRouter,
  type CustomRouterErrorCode,
  type CustomRouterReference,
  type redactProviderHints,
} from '@kilocode/auto-routing-contracts';
import {
  isKiloAutoModel,
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
  ORG_AUTO_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  applyResolvedAutoModel,
  applyResolvedModel,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/resolution';
import { decideCustomRouter } from '@kilocode/web-shared/lib/ai-gateway/auto-model/custom-router';
import {
  checkAutoDecision,
  type AutoDecisionRejection,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-decision';
import {
  fetchCustomRouterDecision,
  fetchEfficientAutoDecision,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-decision';
import {
  collectDataCollectionRequiredAutoRoutingModelIds,
  collectDeniedAutoRoutingModelIds,
  dataCollectionRequiredAutoRoutingCandidates,
  deniedAutoRoutingCandidates,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-denied-models';
import { AUTO_ROUTING_DECISION_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  createDirectByokReferenceResolver,
  getDirectByokModel,
  supportsCatalogMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { byokOwner } from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { isDataCollectionExplicitlyDisallowed } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  autoRoutingUnavailableResponse,
  customRouterErrorResponse,
  invalidAutoDecisionResponse,
  noFreeModelsAvailableResponse,
  organizationAutoConfigurationResponse,
  paidModelAuthRequiredResponse,
  temporarilyUnavailableResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { logMicrodollarUsage } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import type {
  GatewayCaller,
  gatewayUsageContextBase,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import type { BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  getEffectiveModelDecision,
  type EffectiveOrganizationModelPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import type {
  LlmProxyRequestHeaders,
  ValidatedGatewayRequest,
} from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy-request';

type AutoRoutingFailure =
  | { kind: 'caller_rejected'; response: NextResponse }
  | { kind: 'auth_required' }
  | { kind: 'decision_secret_missing' }
  | { kind: 'invalid_auto_decision'; reason: AutoDecisionRejection }
  | { kind: 'no_free_models_available' }
  | { kind: 'organization_auto_configuration'; message: string }
  | { kind: 'custom_router'; code: CustomRouterErrorCode; message: string }
  | { kind: 'unavailable' };

type ModelResolution =
  | { kind: 'direct' }
  | {
      kind: 'routed';
      autoModel: string;
      /**
       * Organization Auto can resolve through an intermediate route target before reaching a
       * concrete model. Kept for direct-BYOK ownership validation.
       */
      routingTarget: string | null;
      /**
       * Efficient/balanced and custom routers pick from a pool, so a policy denial of the picked
       * model is an auto-routing failure rather than a plain model-not-allowed error.
       */
      poolRouted: boolean;
      /** Positive only for auto-routing workers still on the protocol that leaves billing to us. */
      classifierCostUsd: number;
    }
  | {
      kind: 'rejected';
      failure: AutoRoutingFailure;
      autoModel: string | null;
      classifierCostUsd: number;
    };

export type AdmittedModelResolution = Exclude<ModelResolution, { kind: 'rejected' }>;

type ModelResolutionContext = {
  request: ValidatedGatewayRequest;
  requestBodyText: string;
  autoDecisionToken: string | null;
  ipAddress: string;
  headers: LlmProxyRequestHeaders;
  providerHints: ReturnType<typeof redactProviderHints>;
  effectivePrivacy: ReturnType<typeof getEffectiveProviderPrivacy>;
  callerPromise: Promise<GatewayCaller>;
  balanceAndSettingsPromise: Promise<BalanceAndOrgSettings>;
  organizationGroupPolicyPromise: Promise<EffectiveOrganizationModelPolicy | null>;
};

type RoutingCaller = { userId: string; organizationId: string | null };

function rejected(
  failure: AutoRoutingFailure,
  autoModel: string | null = null,
  classifierCostUsd = 0
): ModelResolution {
  return { kind: 'rejected', failure, autoModel, classifierCostUsd };
}

// Custom routers and signed CLI decisions bill an account, so they never fall through to
// anonymous handling.
async function authenticatedRoutingCaller(
  callerPromise: ModelResolutionContext['callerPromise']
): Promise<{ caller: RoutingCaller } | { failure: AutoRoutingFailure }> {
  const caller = await callerPromise;
  if (caller.kind === 'rejected')
    return { failure: { kind: 'caller_rejected', response: caller.response } };
  if (caller.kind === 'anonymous') return { failure: { kind: 'auth_required' } };
  return { caller: { userId: caller.user.id, organizationId: caller.organizationId ?? null } };
}

async function autoRoutingDenials(
  ctx: ModelResolutionContext,
  fromPolicy: (policy: EffectiveOrganizationModelPolicy) => Promise<string[]>,
  fromPrivacy: () => Promise<string[]>
): Promise<string[]> {
  const groupPolicy = await ctx.organizationGroupPolicyPromise;
  const [deniedFromPolicy, deniedFromPrivacy] = await Promise.all([
    groupPolicy ? fromPolicy(groupPolicy) : [],
    isDataCollectionExplicitlyDisallowed(ctx.effectivePrivacy) ? fromPrivacy() : [],
  ]);
  return [...new Set([...deniedFromPolicy, ...deniedFromPrivacy])];
}

function decisionRequest(ctx: ModelResolutionContext, caller: RoutingCaller) {
  return {
    apiKind: ctx.request.kind,
    body: ctx.request.body,
    providerHints: ctx.providerHints,
    bodyBytes: Buffer.byteLength(ctx.requestBodyText),
    userId: caller.userId,
    organizationId: caller.organizationId,
    sessionId: ctx.headers.sessionId,
    machineId: ctx.headers.machineId,
    clientRequestId: ctx.headers.clientRequestId,
    mode: ctx.headers.mode,
    userAgent: ctx.headers.userAgent,
  };
}

async function resolveSignedDecision(
  ctx: ModelResolutionContext,
  token: string
): Promise<ModelResolution> {
  const auth = await authenticatedRoutingCaller(ctx.callerPromise);
  if ('failure' in auth) return rejected(auth.failure);
  if (!AUTO_ROUTING_DECISION_SECRET) {
    console.error(`${AUTO_DECISION_HEADER} received but AUTO_ROUTING_DECISION_SECRET is unset`);
    return rejected({ kind: 'decision_secret_missing' });
  }
  const check = await checkAutoDecision({
    token,
    secret: AUTO_ROUTING_DECISION_SECRET,
    nowMs: Date.now(),
    userId: auth.caller.userId,
    organizationId: auth.caller.organizationId,
    model: ctx.request.body.model,
  });
  if (check.kind === 'rejected') {
    return rejected({ kind: 'invalid_auto_decision', reason: check.reason });
  }
  applyResolvedModel(ctx.request, check.resolved);
  return {
    kind: 'routed',
    autoModel: check.routerModelId,
    routingTarget: null,
    poolRouted: false,
    classifierCostUsd: 0,
  };
}

async function resolveAutoModelId(
  ctx: ModelResolutionContext,
  autoModel: string
): Promise<ModelResolution> {
  const requestedModel = ctx.request.body.model;
  if (isCustomRouterModelId(autoModel)) {
    const auth = await authenticatedRoutingCaller(ctx.callerPromise);
    if ('failure' in auth) return rejected(auth.failure, autoModel);
  }
  const isAutoEfficientId =
    autoModel === KILO_AUTO_EFFICIENT_MODEL.id || autoModel === KILO_AUTO_BALANCED_MODEL.id;
  // Set by whichever decision runs; resolution only sees the decision itself.
  let classifierCostUsd = 0;

  const decisionForRouter = async (router: AutoRouter) => {
    const caller = await ctx.callerPromise;
    // The classifier uses Kilo's paid credential. Unauthenticated callers
    // must never spend classification without a user to attribute it to.
    if (caller.kind !== 'signed-in') return null;
    const owner = { userId: caller.user.id, organizationId: caller.organizationId ?? null };
    const deniedModelIds = await autoRoutingDenials(
      ctx,
      policy => collectDeniedAutoRoutingModelIds(policy, router),
      () => collectDataCollectionRequiredAutoRoutingModelIds(router)
    );
    const result = await fetchEfficientAutoDecision({
      ...decisionRequest(ctx, owner),
      ...(router === 'frontier' ? { router } : {}),
      requestedModel,
      deniedModelIds,
    });
    classifierCostUsd = result?.costUsd ?? 0;
    return result?.decision ?? null;
  };
  const customRouterDecision = async (reference: CustomRouterReference) => {
    const auth = await authenticatedRoutingCaller(ctx.callerPromise);
    if ('failure' in auth) {
      return {
        kind: 'rejected',
        code: 'unauthorized',
        message: 'Custom routers require an authenticated user',
      } as const;
    }
    const { caller } = auth;
    return await decideCustomRouter({
      reference,
      ...caller,
      deniedModelIds: candidateIds =>
        autoRoutingDenials(
          ctx,
          policy => deniedAutoRoutingCandidates(policy, candidateIds),
          () => dataCollectionRequiredAutoRoutingCandidates(candidateIds)
        ),
      decide: async (router, deniedModelIds) => {
        const outcome = await fetchCustomRouterDecision({
          ...decisionRequest(ctx, caller),
          router: router.baseRouter,
          customRouter: reference,
          requestedModel: customRouterModelId(router.ownerType, router.slug),
          deniedModelIds,
        });
        if (outcome.kind === 'ok') classifierCostUsd = outcome.costUsd;
        return outcome;
      },
    });
  };

  const result = await applyResolvedAutoModel(
    {
      model: autoModel,
      modeHeader: ctx.headers.mode,
      sessionId: ctx.headers.taskId,
      apiKind: ctx.request.kind,
      clientIp: ctx.ipAddress,
      efficientDecision:
        isAutoEfficientId || autoModel === ORG_AUTO_MODEL.id
          ? () => decisionForRouter('efficient')
          : undefined,
      frontierDecision:
        autoModel === KILO_AUTO_FRONTIER_MODEL.id || autoModel === ORG_AUTO_MODEL.id
          ? () => decisionForRouter('frontier')
          : undefined,
      customRouterDecision,
      organizationContext: Promise.all([ctx.callerPromise, ctx.balanceAndSettingsPromise]).then(
        ([caller, { settings, plan }]) => ({
          organizationId: caller.kind === 'signed-in' ? caller.organizationId : undefined,
          settings,
          plan,
        })
      ),
      isAutoFreeCandidateAllowed: async modelId => {
        const policy = await ctx.organizationGroupPolicyPromise;
        return policy ? (await getEffectiveModelDecision(policy, modelId)).allowed : true;
      },
    },
    ctx.request,
    ctx.callerPromise.then(caller => (caller.kind === 'signed-in' ? caller.user : null)),
    ctx.balanceAndSettingsPromise.then(res => res.balance)
  );
  switch (result.kind) {
    case 'ok':
      return {
        kind: 'routed',
        autoModel,
        routingTarget: result.routingTarget ?? null,
        poolRouted: isAutoEfficientId || isCustomRouterModelId(autoModel),
        classifierCostUsd,
      };
    case 'no_free_models_available':
      return rejected({ kind: 'no_free_models_available' }, autoModel, classifierCostUsd);
    case 'organization_auto_configuration_error':
      return rejected(
        { kind: 'organization_auto_configuration', message: result.message },
        autoModel,
        classifierCostUsd
      );
    case 'custom_router_error':
      return rejected(
        { kind: 'custom_router', code: result.code, message: result.message },
        autoModel,
        classifierCostUsd
      );
    case 'auto_routing_unavailable':
      return rejected({ kind: 'unavailable' }, autoModel, classifierCostUsd);
  }
}

/**
 * The catalog id that replaces an auto-routed bespoke direct BYOK id when the caller's key for it
 * is in catalog mode. Null when the id needs no replacement or has no catalog id; an unmapped id
 * then gets the catalog-only error from `getProvider`.
 */
async function catalogModeModelForRoutedModel(
  model: string,
  callerPromise: ModelResolutionContext['callerPromise']
): Promise<string | null> {
  const { provider } = await getDirectByokModel(model.toLowerCase());
  if (!provider || !supportsCatalogMode(provider.id)) return null;
  const caller = await callerPromise;
  if (caller.kind !== 'signed-in') return null;
  const resolveReference = await createDirectByokReferenceResolver(
    byokOwner(caller.user.id, caller.organizationId)
  );
  const resolved = await resolveReference(model);
  return resolved === model ? null : resolved;
}

/**
 * Resolves Kilo Auto ids and signed auto decisions to a concrete model, writing it to the request
 * body. Direct model ids pass through unchanged.
 */
export async function resolveModel(ctx: ModelResolutionContext): Promise<ModelResolution> {
  const requestedModelLowerCased = ctx.request.body.model.toLowerCase();
  let resolution: ModelResolution = { kind: 'direct' };
  if (ctx.autoDecisionToken !== null) {
    resolution = await resolveSignedDecision(ctx, ctx.autoDecisionToken);
  } else if (isKiloAutoModel(requestedModelLowerCased)) {
    resolution = await resolveAutoModelId(ctx, requestedModelLowerCased);
  }
  if (resolution.kind === 'routed') {
    // A router entry stored with a bespoke id keeps working when its key switches to catalog mode;
    // the catalog id then goes through the organization policy check.
    const catalogModelId = await catalogModeModelForRoutedModel(
      ctx.request.body.model,
      ctx.callerPromise
    );
    if (catalogModelId) ctx.request.body.model = catalogModelId;
  }
  return resolution;
}

export function autoRoutingFailureResponse(failure: AutoRoutingFailure, requestedModel: string) {
  switch (failure.kind) {
    case 'caller_rejected':
      return failure.response;
    case 'auth_required':
      return paidModelAuthRequiredResponse();
    case 'decision_secret_missing':
      return temporarilyUnavailableResponse();
    case 'invalid_auto_decision':
      return invalidAutoDecisionResponse(failure.reason);
    case 'no_free_models_available':
      return noFreeModelsAvailableResponse();
    case 'organization_auto_configuration':
      return organizationAutoConfigurationResponse(failure.message);
    case 'custom_router':
      return customRouterErrorResponse(failure.code, failure.message);
    case 'unavailable':
      return autoRoutingUnavailableResponse(requestedModel);
  }
}

/**
 * New workers persist classifier usage themselves and return zero. Retain positive-cost billing
 * only for workers still running the previous protocol.
 */
export function billLegacyClassifierCost(
  resolution: ModelResolution,
  usage: ReturnType<typeof gatewayUsageContextBase>['context'] &
    Pick<MicrodollarUsageContext, 'api_kind' | 'requested_model' | 'feature' | 'clientRequestId'>
): void {
  if (resolution.kind === 'direct' || !(resolution.classifierCostUsd > 0)) return;
  const costMicrodollars = toMicrodollars(resolution.classifierCostUsd);
  after(
    (async () => {
      try {
        await logMicrodollarUsage(
          {
            messageId: null,
            model: 'auto-routing/classifier',
            responseContent: '',
            hasError: false,
            inference_provider: null,
            upstream_id: null,
            finish_reason: null,
            latency: null,
            moderation_latency: null,
            generation_time: null,
            streamed: false,
            cancelled: false,
            status_code: 200,
            cost_mUsd: costMicrodollars,
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheHitTokens: 0,
            is_byok: false,
          },
          {
            ...usage,
            provider: 'openrouter',
            is_free: false,
            promptInfo: {
              system_prompt_prefix: '',
              system_prompt_length: 0,
              user_prompt_prefix: '',
            },
            isStreaming: false,
            // No posthog_distinct_id: this internal overhead row must not emit
            // the generic first_usage / first_microdollar_usage lifecycle
            // events (those are gated on posthog_distinct_id in processUsage).
            // Otherwise the classifier row could race the primary usage row and
            // mis-attribute `auto-routing/classifier` as the user's first model.
            // DB billing is unaffected — it keys on kiloUserId.
            posthog_distinct_id: undefined,
            status_code: 200,
            user_byok: false,
            has_tools: false,
            auto_model: resolution.autoModel,
          }
        );
      } catch (error) {
        console.error('Failed to bill classifier cost for auto routing', error);
      }
    })()
  );
}
