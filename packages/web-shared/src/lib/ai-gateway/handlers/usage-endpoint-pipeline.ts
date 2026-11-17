import { NextResponse, type NextRequest, type NextResponse as NextResponseType } from 'next/server';
import { setTag, startInactiveSpan, type Span } from '@sentry/nextjs';
import type { User } from '@kilocode/db/schema';
import type { OrganizationDataRegion } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { sentryRootSpan } from '@kilocode/web-shared/lib/getRootSpan';
import { validateFeatureHeader, FEATURE_HEADER } from '@kilocode/web-shared/lib/feature-detection';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import type { AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  PromptInfo,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import type { BYOKResult, Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type {
  OrganizationPlan,
  OrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import type { BalancePayer } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  resolveOrganizationMemberModelDecision,
  type EffectiveModelDecision,
} from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { generateProviderSpecificHash } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { isByokEndpointModelId } from '@kilocode/web-shared/lib/ai-gateway/byok-endpoint';
import {
  extractHeaderAndLimitLength,
  makeErrorReadable,
  modelDoesNotExistResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  freeModelRateLimitRejection,
  gatewayAccountRateLimitRejection,
  gatewaySettingsRejection,
  gatewayUsageContextBase,
  organizationProviderPreferences,
  paidUsageRejection,
  readGatewayBalance,
  resolveGatewayCaller,
  resolveOrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import {
  getRouteInferenceRegion,
  type OrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import {
  bareIpLiteral,
  bouncerDecideTier,
  rawClientIp,
} from '@kilocode/web-shared/lib/bouncer/inference';
import {
  anonymousBouncerRequest,
  signedInBouncerRequest,
} from '@kilocode/web-shared/lib/bouncer/request';
import {
  emitApiMetricsForResponse,
  emitGatewayApiMetrics,
  type ApiMetricsParams,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import {
  responseUsageContext,
  rewriteModelResponse_UsageEndpoint,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.usageEndpoints';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import { fetchUpstream } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';

type RequestProviderPrivacy = Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'>;

export type ParsedUsageRequest<Body> = {
  kind: 'parsed';
  body: Body;
  /** The requested model, trimmed but not lowercased. */
  model: string;
  /** The request's validated provider preferences. */
  requestProvider: RequestProviderPrivacy | undefined;
  promptInfo: PromptInfo;
};

type UsageEndpointUpstreamBodyInput<Body> = {
  body: Body;
  requestedModel: string;
  requestedModelLowerCased: string;
  provider: Provider;
  userByok: BYOKResult[] | null;
  safetyIdentifier: string;
  requestProvider: RequestProviderPrivacy | undefined;
  /** The organization's provider preferences, merged with the request's privacy. */
  organizationProvider: OpenRouterProviderConfig | undefined;
  organizationSettings: OrganizationSettings | undefined;
  /** The region to pin the route's inference to: set only for Kilo's Vercel AI Gateway route. */
  dataRegion: OrganizationDataRegion | null;
};

type UsageEndpointUpstreamResponse = {
  response: Response;
  usageContext: MicrodollarUsageContext;
  requestSpan: Span;
  provider: Provider;
  userByok: BYOKResult[] | null;
  requestedModelLowerCased: string;
  metricsParams: Omit<ApiMetricsParams, 'completeRequestMs'>;
  requestStartedAt: number;
  vercelRequestId: string | null;
};

export type UsageEndpoint<Body> = {
  apiKind: 'embeddings' | 'audio_transcriptions';
  /** Prefix of the Sentry request span and root span attribute. */
  spanPrefix: 'embedding' | 'transcription';
  path: string;
  durationBudgetMs: number;
  /** Validated as the feature when the request has no feature header. */
  defaultFeature: string;
  /**
   * Free models serve callers without credentials. Otherwise a failed authentication answers with
   * its own response.
   */
  allowAnonymousFreeModels: boolean;
  parse(
    request: NextRequest
  ): Promise<ParsedUsageRequest<Body> | { kind: 'rejected'; response: NextResponse }>;
  /**
   * Picks the upstream provider. `organizationDecision` resolves the member's model decision once;
   * the pipeline resolves it later, before applying provider preferences, if this does not.
   */
  resolveProvider(input: {
    requestedModelLowerCased: string;
    user: User | AnonymousUserContext;
    organizationId: string | undefined;
    organizationDecision: () => Promise<EffectiveModelDecision | undefined>;
    /** The organization's gateway settings; the pipeline checks the chosen route against them. */
    gatewaySettings: OrganizationGatewaySettings;
  }): Promise<{ provider: Provider; userByok: BYOKResult[] | null; isFree: boolean }>;
  /** A request rejection after the account checks, before bouncer decides. */
  validate?(body: Body, requestedModelLowerCased: string): NextResponse | null;
  buildUpstreamBody(input: UsageEndpointUpstreamBodyInput<Body>): Promise<
    | {
        body: Record<string, unknown> | FormData;
        /** The data region the upstream request pins inference to, if any. */
        inferenceRegion?: OrganizationDataRegion | null;
      }
    /** The route cannot serve the request, such as when no eligible provider remains. */
    | { rejection: NextResponse }
  >;
  /** Accounts for a response the upstream error policy let through, and answers the client. */
  accountAndRespond(upstream: UsageEndpointUpstreamResponse): Promise<NextResponseType<unknown>>;
};

/**
 * Serves a non-streaming usage endpoint, such as embeddings or transcriptions, through the same
 * admission, bouncer, upstream, metrics, and error steps as chat.
 */
export async function handleUsageEndpointRequest<Body>(
  request: NextRequest,
  endpoint: UsageEndpoint<Body>
): Promise<NextResponseType<unknown>> {
  const requestStartedAt = performance.now();
  const requestStartedAtMs = Date.now();

  const ipAddress = rawClientIp(request);
  // Like chat, cap the account before reading the body or authenticating.
  const accountRateLimited = await gatewayAccountRateLimitRejection(request, ipAddress);
  if (accountRateLimited) return accountRateLimited;

  const parsed = await endpoint.parse(request);
  if (parsed.kind === 'rejected') return parsed.response;
  const requestedModel = parsed.model;
  const requestedModelLowerCased = requestedModel.toLowerCase();

  if (!ipAddress) {
    return NextResponse.json(
      {
        error: 'Unable to determine client IP',
        error_type: ProxyErrorType.missing_client_ip,
      },
      { status: 400 }
    );
  }

  const authSpan = startInactiveSpan({ name: 'auth-check' });
  const auth = await getUserFromAuth({ adminOnly: false, expectedAudience: KILO_GATEWAY_AUDIENCE });
  const caller = endpoint.allowAnonymousFreeModels
    ? resolveGatewayCaller(auth, {
        allowAnonymous: isFreeModel(requestedModelLowerCased),
        ipAddress,
      })
    : resolveGatewayCaller(auth, { allowAnonymous: false, passThroughAuthFailure: true });
  authSpan.end();
  if (caller.kind === 'rejected') return caller.response;
  const { user } = caller;
  const organizationId = caller.kind === 'signed-in' ? caller.organizationId : undefined;

  // Custom LLMs and endpoints are served only through chat routes; never forward their ids
  // elsewhere. Checked after auth so anonymous callers cannot probe for them.
  if (
    isByokEndpointModelId(requestedModelLowerCased) ||
    (await isCustomLlm(requestedModelLowerCased))
  ) {
    return modelDoesNotExistResponse();
  }

  const feature = validateFeatureHeader(
    request.headers.get(FEATURE_HEADER) || endpoint.defaultFeature
  );
  if (isFreeModel(requestedModelLowerCased)) {
    const rateLimited = await freeModelRateLimitRejection({
      request,
      caller,
      model: requestedModelLowerCased,
      feature,
    });
    if (rateLimited) return rateLimited;
  }

  const usageBase = gatewayUsageContextBase(request, caller, { requestStartedAt });

  let organizationDecisionPromise: Promise<EffectiveModelDecision | undefined> | undefined;
  const organizationDecision = () =>
    (organizationDecisionPromise ??=
      caller.kind === 'signed-in' && organizationId
        ? resolveOrganizationMemberModelDecision({
            organizationId,
            kiloUserId: user.id,
            modelId: requestedModelLowerCased,
            fromDb: readDb,
          }).then(({ decision }) => decision)
        : Promise.resolve(undefined));

  // Anonymous callers can only use free models, so they have no balance or organization to check.
  const account =
    caller.kind === 'signed-in'
      ? await readGatewayBalance(caller.user, organizationId, requestedModelLowerCased)
      : undefined;
  const gatewaySettings = await resolveOrganizationGatewaySettings({
    organizationId,
    plan: account?.plan,
    settings: account?.settings,
  });

  const { provider, userByok, isFree } = await endpoint.resolveProvider({
    requestedModelLowerCased,
    user,
    organizationId,
    organizationDecision,
    gatewaySettings,
  });

  const bouncerIp = bareIpLiteral(ipAddress);
  const ja4Digest = usageBase.context.fraudHeaders.http_x_vercel_ja4_digest;
  const bouncer =
    caller.kind === 'signed-in'
      ? signedInBouncerRequest({
          ip: bouncerIp,
          ja4Digest,
          userId: user.id,
          organizationId,
          feature,
        })
      : anonymousBouncerRequest({ ip: bouncerIp, ja4Digest });

  const usageContext: MicrodollarUsageContext = {
    ...usageBase.context,
    api_kind: endpoint.apiKind,
    provider: provider.type,
    requested_model: requestedModelLowerCased,
    is_free: isFree,
    promptInfo: parsed.promptInfo,
    isStreaming: false,
    user_byok: !!userByok,
    has_tools: false,
    feature,
  };
  const bouncerUsageFields = {
    occurredAt: new Date(requestStartedAtMs),
    clientAttributed: usageBase.clientAttributed,
    requestedLogprobs: false,
    samples: null,
    // No bouncer rule reads embedding input or audio, so no prompt hash is computed.
    promptSimHash: null,
  };

  setTag('ui.ai_model', requestedModel);

  let organizationSettings: OrganizationSettings | undefined;
  let organizationProvider: OpenRouterProviderConfig | undefined;
  let accountBalance = 0;
  let accountPlan: OrganizationPlan | undefined;
  let accountPayer: BalancePayer | undefined;
  let dataRegion: OrganizationDataRegion | null = null;

  if (caller.kind === 'signed-in' && account) {
    const { balance, settings, plan, payer } = account;
    accountBalance = balance;
    accountPlan = plan;
    accountPayer = payer;
    organizationSettings = settings;

    const gatewayRejection = gatewaySettingsRejection(gatewaySettings, { provider, userByok });
    if (gatewayRejection) return gatewayRejection;
    dataRegion = getRouteInferenceRegion(gatewaySettings, { provider, userByok });

    // Free models are Kilo- or partner-funded: a zero balance never blocks them.
    const creditsBlocked = paidUsageRejection({
      user: caller.user,
      organizationId,
      account,
      exempt: usageContext.is_free || !!userByok,
    });
    if (creditsBlocked) return await creditsBlocked();

    const preferences = organizationProviderPreferences({
      decision: await organizationDecision(),
      settings,
      requestProvider: parsed.requestProvider,
    });
    if (preferences.kind === 'rejected') return preferences.response;
    organizationProvider = preferences.provider;
  }

  // The usage row reports the payer the balance check resolved: the root organization for an
  // organization member.
  usageContext.bouncer = await (bouncer.kind === 'signed-in'
    ? bouncer.usage(bouncerUsageFields, accountPayer)
    : bouncer.usage(bouncerUsageFields));

  sentryRootSpan()?.setAttribute(
    `${endpoint.spanPrefix}.time_to_request_start_ms`,
    performance.now() - requestStartedAt
  );

  const validationError = endpoint.validate?.(parsed.body, requestedModelLowerCased);
  if (validationError) return validationError;

  // Built before bouncer decides, so a request the route cannot serve is rejected without a decide
  // or a usage row: it never reaches the provider.
  const upstreamBody = await endpoint.buildUpstreamBody({
    body: parsed.body,
    requestedModel,
    requestedModelLowerCased,
    provider,
    userByok,
    // Always set the hashed identifier for upstream abuse attribution / safety scoping.
    safetyIdentifier: generateProviderSpecificHash(user.id, provider),
    requestProvider: parsed.requestProvider,
    organizationProvider,
    organizationSettings,
    dataRegion,
  });
  if ('rejection' in upstreamBody) return upstreamBody.rejection;
  usageContext.inference_region = upstreamBody.inferenceRegion ?? null;

  // The one decide for this request, awaited just before the upstream call within its 500 ms
  // budget. Only an enforced verdict rejects; every other outcome sends the request.
  const bouncerVerdictPromise =
    bouncer.kind === 'signed-in'
      ? bouncer.decide({
          tier: bouncerDecideTier(organizationId, accountPlan, accountBalance),
          payer: accountPayer,
        })
      : bouncer.decide();

  const requestSpan = startInactiveSpan({
    name: `${endpoint.spanPrefix}-request-start`,
    op: 'http.client',
  });

  const bouncerVerdict = await bouncerVerdictPromise;
  const bouncerRejection = bouncer.apply(bouncerVerdict, usageContext.bouncer);
  if (bouncerRejection) return bouncerRejection;

  const vercelRequestId = extractHeaderAndLimitLength(request, 'x-vercel-id');
  const upstream = await fetchUpstream({
    provider,
    path: endpoint.path,
    method: 'POST',
    body: upstreamBody.body,
    signal: request.signal,
    vercelRequestId,
    durationBudgetMs: endpoint.durationBudgetMs,
  });

  const ttfbMs = Math.max(0, Math.round(performance.now() - requestStartedAt));
  usageContext.ttfb_ms = ttfbMs;

  const metricsParams = {
    kiloUserId: user.id,
    organizationId,
    isAnonymous: caller.kind === 'anonymous',
    isStreaming: false,
    userByok: !!userByok,
    mode: usageContext.mode || undefined,
    provider: provider.type,
    requestedModel: requestedModelLowerCased,
    resolvedModel: normalizeModelId(requestedModelLowerCased),
    toolsAvailable: [],
    toolsUsed: [],
    ttfbMs,
    statusCode: upstream.response.status,
  };

  if (upstream.type === 'error') {
    emitGatewayApiMetrics({ ...metricsParams, completeRequestMs: ttfbMs });
    return upstream.response;
  }
  const { response } = upstream;
  usageContext.status_code = response.status;

  const upstreamErrorResponse = await applyUpstreamErrorPolicy({
    response,
    providerId: provider.type,
    isUserByok: !!userByok,
    user,
    request: upstreamBody.body,
    organizationId,
    model: requestedModelLowerCased,
  });
  if (upstreamErrorResponse) {
    emitGatewayApiMetrics({ ...metricsParams, completeRequestMs: ttfbMs });
    return upstreamErrorResponse;
  }

  return await endpoint.accountAndRespond({
    response,
    usageContext,
    requestSpan,
    provider,
    userByok,
    requestedModelLowerCased,
    metricsParams,
    requestStartedAt,
    vercelRequestId,
  });
}

/**
 * Starts usage accounting on a clone of the response, then answers with a readable upstream
 * error or the rewritten response.
 */
export async function accountAndRewriteUsageResponse(
  upstream: UsageEndpointUpstreamResponse,
  countAndStoreUsage: (
    response: Response,
    usageContext: MicrodollarUsageContext,
    requestSpan: Span,
    provider: Provider
  ) => { statsPromise: Promise<Pick<MicrodollarUsageStats, 'inference_provider'> | null> }
): Promise<NextResponseType<unknown>> {
  const { response, usageContext, provider, userByok } = upstream;
  // Reading the body is side-effectful, so accounting reads a clone.
  const accounting = countAndStoreUsage(
    response.clone(),
    usageContext,
    upstream.requestSpan,
    provider
  );
  emitApiMetricsForResponse(
    upstream.metricsParams,
    accounting.statsPromise,
    upstream.requestStartedAt
  );

  const readableError = await makeErrorReadable({
    provider: provider.type,
    requestedModel: upstream.requestedModelLowerCased,
    request: null,
    response,
    userByokProviderIds: userByok?.map(byok => byok.providerId) ?? null,
  });
  if (readableError) return readableError;

  return await rewriteModelResponse_UsageEndpoint({
    response,
    usageContext: responseUsageContext(usageContext, await getCustomPricingConfig()),
    vercelRequestId: upstream.vercelRequestId,
  });
}
