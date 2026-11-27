import type { NextRequest, NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { FEATURE_HEADER, validateFeatureHeader } from '@kilocode/web-shared/lib/feature-detection';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  createAnonymousContext,
  type AnonymousUserContext,
} from '@kilocode/web-shared/lib/anonymous';
import { canSpendPaidUsage } from '@kilocode/worker-utils/account-access';
import { gatewayBalanceRead } from '@kilocode/web-shared/lib/ai-gateway/benchmark-balance-policy';
import type { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getBalanceAndOrgSettings,
  type BalanceAndOrgSettings,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  isDeniedByProviderPrivacy,
  isFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { isOwnerByokModelId } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/owner-byok-model-id';
import { isCustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import type {
  OrganizationPlan,
  OrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import type { EffectiveModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  composeProviderPreferences,
  getEffectiveProviderPrivacy,
} from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import {
  accountFreeModelLimitResponse,
  anonymousFreeModelLimitResponse,
  creditsBlockedResponse,
  dataCollectionRequiredResponse,
  zeroDataRetentionUnavailableResponse,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  gatewayAccountRateLimitResponse,
  getOrganizationProviderPrivacy,
  inferenceRegionRefusedResponse,
  invalidTokenResponse,
  managedGatewayDisabledResponse,
  modelNotAllowedResponse,
  paidModelAuthRequiredResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import {
  freeModelRateLimitKey,
  isFreeModelRateLimited,
  type FreeModelRateLimitSubject,
} from '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit';
import { DEFAULT_BENCHMARK_USER_ID } from '@kilocode/auto-routing-contracts';
import type { BenchmarkGatewayAssignment } from '@kilocode/auto-routing-contracts';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { isUserBlacklistedByDomain } from '@kilocode/web-shared/lib/user/domain-gates';
import { benchmarkRefusalResponse } from '@kilocode/web-shared/lib/ai-gateway/benchmark-case-admission';
import {
  getGatewaySettingsRefusal,
  getOrganizationGatewaySettings,
  NO_ORGANIZATION_GATEWAY_SETTINGS,
  type GatewayPolicyRoute,
  type OrganizationGatewaySettings,
} from '@kilocode/web-shared/lib/ai-gateway/providers/organization-gateway-settings';
import { getRuntimeOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';

type GatewayAuthResult = Awaited<ReturnType<typeof getUserFromAuth>>;

export type SignedInGatewayCaller = {
  kind: 'signed-in';
  user: User;
  organizationId: string | undefined;
  botId?: string;
  /** The request came through the Cloud Agent runtime credential proxy (verified attestation). */
  cloudAgentRuntimeProxied: boolean;
};
export type AnonymousGatewayCaller = { kind: 'anonymous'; user: AnonymousUserContext };
export type RejectedGatewayCaller = { kind: 'rejected'; response: NextResponse };
export type GatewayCaller = SignedInGatewayCaller | AnonymousGatewayCaller | RejectedGatewayCaller;

/**
 * Caps one account's inference request rate across every source address. Routes
 * call this before authentication: the key comes from the signed token, so a
 * flooded request costs no database query. See `isGatewayAccountRateLimited`.
 * Autocomplete routes skip it; see `packages/web-shared/AGENTS.md`.
 */
export async function gatewayAccountRateLimitRejection(
  request: NextRequest,
  ipAddress: string | undefined
): Promise<NextResponse | null> {
  const accountKey = gatewayRateLimitKey(request.headers, ipAddress);
  if (!(await isGatewayAccountRateLimited(request, accountKey))) return null;
  console.warn(`Gateway account rate limit exceeded, user: ${accountKey}`);
  return gatewayAccountRateLimitResponse();
}

/**
 * The anti-abuse limit for free models. Signed-in callers count per account,
 * anonymous callers per IP. Takes the resolved caller rather than the token's
 * claims, so a revoked token cannot spend its account's allowance.
 */
export async function freeModelRateLimitRejection(params: {
  request: NextRequest;
  caller: SignedInGatewayCaller | AnonymousGatewayCaller;
  model: string;
  feature: string | null;
}): Promise<NextResponse | null> {
  const { caller } = params;
  const subject: FreeModelRateLimitSubject =
    caller.kind === 'signed-in'
      ? { kind: 'account', kiloUserId: caller.user.id }
      : { kind: 'ip', ipAddress: caller.user.ipAddress };

  // The default internal benchmark user is exempt: a run sends every case of
  // every free model it measures, and the anti-abuse limit would otherwise
  // throttle the measurement itself. A benchmark user override is not exempt.
  const isExempt = subject.kind === 'account' && subject.kiloUserId === DEFAULT_BENCHMARK_USER_ID;
  if (isExempt || !(await isFreeModelRateLimited(params.request, subject))) return null;
  console.warn(
    `Model rate limit exceeded, ${freeModelRateLimitKey(subject)}, model: ${params.model}, feature: ${params.feature ?? 'none'}`
  );
  return subject.kind === 'account'
    ? accountFreeModelLimitResponse()
    : anonymousFreeModelLimitResponse();
}

/**
 * Null when the organization's gateway settings admit the route, otherwise the response that
 * explains which setting refuses it. See `getGatewaySettingsRefusal`.
 */
export function gatewaySettingsRejection(
  settings: OrganizationGatewaySettings,
  route: GatewayPolicyRoute
): NextResponse | null {
  const refusal = getGatewaySettingsRefusal(settings, route);
  if (!refusal) return null;
  return refusal.kind === 'inference-region'
    ? inferenceRegionRefusedResponse(refusal.region)
    : managedGatewayDisabledResponse(refusal.kind);
}

/**
 * The gateway settings that apply to a request: the organization's, when its plan and the
 * organization feature let them take effect, and none outside an organization.
 */
export async function resolveOrganizationGatewaySettings(params: {
  organizationId: string | undefined;
  plan: OrganizationPlan | undefined;
  settings: OrganizationSettings | undefined;
}): Promise<OrganizationGatewaySettings> {
  const { organizationId, plan, settings } = params;
  if (!organizationId || !settings) return NO_ORGANIZATION_GATEWAY_SETTINGS;
  return getOrganizationGatewaySettings(await getRuntimeOrganizationFeatures(), {
    id: organizationId,
    plan,
    settings,
  });
}

/**
 * Who an inference request runs as. A presented credential that failed
 * verification is never downgraded to anonymous; see `invalidTokenResponse`.
 *
 * This rule covers inference requests only. The public model catalog routes
 * return the catalog to every caller, and a verified organization member
 * receives it filtered to that member's own model access.
 *
 * A refused authorization always returns the authentication layer's response,
 * whether or not `passThroughAuthFailure` is set. That covers a blocked
 * account, a blacklisted domain, a non-member organization, and an admin-only
 * route. `passThroughAuthFailure` returns any other auth failure as is, instead
 * of the sign-in prompt.
 */
export function resolveGatewayCaller(
  auth: GatewayAuthResult,
  opts: { allowAnonymous: false; passThroughAuthFailure?: boolean }
): SignedInGatewayCaller | RejectedGatewayCaller;
export function resolveGatewayCaller(
  auth: GatewayAuthResult,
  opts: { allowAnonymous: boolean; ipAddress: string | undefined }
): GatewayCaller;
export function resolveGatewayCaller(
  auth: GatewayAuthResult,
  opts: { allowAnonymous: boolean; ipAddress?: string; passThroughAuthFailure?: boolean }
): GatewayCaller {
  if (!auth.authFailedResponse) {
    return {
      kind: 'signed-in',
      user: auth.user,
      organizationId: auth.organizationId,
      botId: auth.botId,
      cloudAgentRuntimeProxied: auth.cloudAgentRuntimeProxied === true,
    };
  }
  if (auth.rejectionReason === 'empty_organization_context') {
    return { kind: 'rejected', response: auth.authFailedResponse };
  }
  if (auth.credentialsRejected) return { kind: 'rejected', response: invalidTokenResponse() };
  if (auth.authorizationRefused) return { kind: 'rejected', response: auth.authFailedResponse };
  if (opts.passThroughAuthFailure) return { kind: 'rejected', response: auth.authFailedResponse };
  if (opts.allowAnonymous && opts.ipAddress) {
    return { kind: 'anonymous', user: createAnonymousContext(opts.ipAddress) };
  }
  return { kind: 'rejected', response: paidModelAuthRequiredResponse() };
}

/** Free models are not usage-funded, so reading their balance skips auto top-up. */
export function readGatewayBalance(
  user: User,
  organizationId: string | undefined,
  model: string,
  /**
   * `noAutoTopUp`: a benchmark case never initiates a purchase for its payer.
   * `fresh`: read the primary. A benchmark payer was just debited by another case request in
   * the same run, and a replica lag would admit the next request on a stale balance.
   */
  options: { noAutoTopUp?: boolean; fresh?: boolean } = {}
): Promise<BalanceAndOrgSettings> {
  const read = gatewayBalanceRead({
    isFreeModel: isFreeModel(model),
    benchmark: Boolean(options.fresh || options.noAutoTopUp),
  });
  return getBalanceAndOrgSettings(
    organizationId,
    user,
    read.fresh ? db : readDb,
    read.fundUsage ? 'usage' : undefined
  );
}

/**
 * The account a benchmark case request runs as. The Worker signed the payer and the actor;
 * this loads the actor row and, for an organization payer, the actor's membership is what
 * `readGatewayBalance` needs. A payer that does not resolve fails closed: a case request is
 * never served unbilled.
 *
 * This is not a user credential. It cannot be produced by a caller of the public proxy,
 * because the assignment HMAC is verified before this runs.
 */
export async function resolveBenchmarkCaller(
  assignment: BenchmarkGatewayAssignment
): Promise<GatewayCaller> {
  const subjectId =
    assignment.payer?.type === 'user' ? assignment.payer.id : assignment.actorUserId;
  const user = await findUserById(subjectId);
  // An unresolvable payer is an identity refusal, never a payment one: the Worker keeps the
  // account and pauses rather than rotating to someone the run never signed.
  if (!user)
    return { kind: 'rejected', response: benchmarkRefusalResponse('payer_unavailable', false) };
  // Ordinary user/server auth refuses a blocked account and an audit-flagged blacklisted domain
  // before serving a request; a balance read does not, so a personal payer would otherwise
  // spend while blocked. Fail closed for both.
  if (isBlockedAccount(user)) {
    return { kind: 'rejected', response: benchmarkRefusalResponse('payer_unavailable', false) };
  }
  if (await isUserBlacklistedByDomain(user, readDb)) {
    return { kind: 'rejected', response: benchmarkRefusalResponse('payer_unavailable', false) };
  }
  // A platform-covered call bills the signed benchmark organization; a paid call bills its
  // signed payer (the organization, or nobody for a personal payer).
  const organizationId =
    assignment.payer?.type === 'organization'
      ? assignment.payer.id
      : assignment.payer === null
        ? (assignment.platformOrganizationId ?? undefined)
        : undefined;
  if (assignment.payer === null && !organizationId) {
    // The schema already refuses this; failing closed here keeps a future caller safe.
    return { kind: 'rejected', response: benchmarkRefusalResponse('payer_unavailable', false) };
  }
  return {
    kind: 'signed-in',
    user,
    organizationId,
    botId: undefined,
    cloudAgentRuntimeProxied: false,
  };
}

/**
 * Null when the account can spend or the request is exempt from paid usage.
 * Otherwise a builder for the credits-blocked response, which is lazy because
 * that response reads payment and top-up state.
 */
export function paidUsageRejection(params: {
  user: User;
  organizationId: string | undefined;
  account: Pick<BalanceAndOrgSettings, 'balance' | 'balanceLimitedByUserAllowance'>;
  exempt: boolean;
}): (() => Promise<NextResponse>) | null {
  const { user, organizationId, account, exempt } = params;
  if (exempt || canSpendPaidUsage(account.balance)) return null;
  return () =>
    creditsBlockedResponse({
      user,
      balance: account.balance,
      organizationId,
      balanceLimitedByUserAllowance: account.balanceLimitedByUserAllowance,
    });
}

/**
 * The provider preferences the organization requires: its data collection
 * policy and the member decision's provider routes, applied over the request's
 * own provider object. `provider` is undefined when the organization requires
 * neither, so the request's provider preferences stand.
 */
export function organizationProviderPreferences(params: {
  decision: EffectiveModelDecision | undefined;
  settings: OrganizationSettings | undefined;
  requestProvider: OpenRouterProviderConfig | undefined;
}):
  | { kind: 'rejected'; response: NextResponse }
  | { kind: 'allowed'; provider: OpenRouterProviderConfig | undefined } {
  const { decision, settings, requestProvider } = params;
  if (decision && !decision.allowed) {
    return { kind: 'rejected', response: modelNotAllowedResponse() };
  }
  const only = decision?.eligibleProviderRoutes
    ? withoutVirtualProvider([...decision.eligibleProviderRoutes])
    : undefined;
  if (only?.length === 0) return { kind: 'rejected', response: modelNotAllowedResponse() };
  const organizationPrivacy = getOrganizationProviderPrivacy(settings);
  if (!organizationPrivacy && !only) return { kind: 'allowed', provider: undefined };
  const composed = composeProviderPreferences({
    requestProvider,
    organizationOnly: only,
    effectivePrivacy: getEffectiveProviderPrivacy(requestProvider, settings?.data_collection),
  });
  if (composed.kind === 'none') return { kind: 'rejected', response: modelNotAllowedResponse() };
  return { kind: 'allowed', provider: composed.provider };
}

/** Rejects a model the effective provider privacy policy rules out; see `isDeniedByProviderPrivacy`. */
export async function dataCollectionPolicyRejection(
  model: string,
  effectiveProviderPolicy: OpenRouterProviderConfig | undefined
): Promise<NextResponse | null> {
  const customLlm = await isCustomLlm(model);
  // Kilo does not vouch for zero data retention on any custom LLM.
  if (effectiveProviderPolicy?.zdr === true && customLlm) {
    return zeroDataRetentionUnavailableResponse();
  }
  // An organization's own upstream is not a free model whatever its id ends with, and Kilo has no
  // data-collection knowledge of it.
  if (!customLlm && (await isOwnerByokModelId(model))) return null;
  if (await isDeniedByProviderPrivacy(model, effectiveProviderPolicy)) {
    return dataCollectionRequiredResponse();
  }
  return null;
}

/**
 * The usage context fields every inference route derives the same way, from the
 * request headers and the caller. Routes add their own fields on top.
 *
 * `clientAttributed` marks a Kilo client for bouncer. It reads only the client's
 * own feature or version header, never a route's fallback feature.
 */
export function gatewayUsageContextBase(
  request: NextRequest,
  caller: SignedInGatewayCaller | AnonymousGatewayCaller,
  opts: { requestStartedAt: number }
) {
  const { fraudHeaders, projectId, xKiloCodeVersion } = extractFraudAndProjectHeaders(request);
  const context = {
    kiloUserId: caller.user.id,
    organizationId: caller.kind === 'signed-in' ? caller.organizationId : undefined,
    fraudHeaders,
    project_id: projectId,
    editor_name: extractHeaderAndLimitLength(request, 'x-kilocode-editorname'),
    machine_id: extractHeaderAndLimitLength(request, 'x-kilocode-machineid'),
    mode: extractHeaderAndLimitLength(request, 'x-kilocode-mode'),
    session_id:
      extractHeaderAndLimitLength(request, 'x-kilocode-taskid') ??
      extractHeaderAndLimitLength(request, 'x-kilo-session'),
    posthog_distinct_id: caller.kind === 'signed-in' ? caller.user.google_user_email : undefined,
    prior_microdollar_usage: caller.user.microdollars_used,
    requestStartedAt: opts.requestStartedAt,
    custom_llm_pricing: null,
    max_tokens: null,
    has_middle_out_transform: null,
    reasoning_setting: null,
    inference_region: null,
    status_code: null,
    auto_model: null,
    ttfb_ms: null,
  } satisfies Partial<MicrodollarUsageContext>;
  const clientAttributed =
    validateFeatureHeader(request.headers.get(FEATURE_HEADER)) !== null ||
    Boolean(xKiloCodeVersion);
  return { context, clientAttributed };
}
