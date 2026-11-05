import type { NextRequest, NextResponse } from 'next/server';
import { captureMessage } from '@sentry/nextjs';
import type { User } from '@kilocode/db/schema';
import { FEATURE_HEADER, validateFeatureHeader } from '@kilocode/web-shared/lib/feature-detection';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import {
  createAnonymousContext,
  type AnonymousUserContext,
} from '@kilocode/web-shared/lib/anonymous';
import { canSpendPaidUsage } from '@kilocode/worker-utils/account-access';
import type { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  getBalanceAndOrgSettings,
  type BalanceAndOrgSettings,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { EffectiveModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import {
  creditsBlockedResponse,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  getOrganizationProviderPrivacy,
  invalidTokenResponse,
  modelNotAllowedResponse,
  paidModelAuthRequiredResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { reservePaidSpend } from '@kilocode/web-shared/lib/ai-gateway/spend-reservation';

/** A paid request that may run, and how to give back the spend it holds. */
export type SpendAdmission =
  | {
      kind: 'admitted';
      /** Null when nothing was held, either because the request is unbounded or the store was down. */
      release: (() => Promise<void>) | null;
    }
  /** The payer's available balance cannot cover the request's maximum cost. */
  | { kind: 'insufficient' };

type GatewayAuthResult = Awaited<ReturnType<typeof getUserFromAuth>>;

export type SignedInGatewayCaller = {
  kind: 'signed-in';
  user: User;
  organizationId: string | undefined;
  botId?: string;
};
export type AnonymousGatewayCaller = { kind: 'anonymous'; user: AnonymousUserContext };
export type RejectedGatewayCaller = { kind: 'rejected'; response: NextResponse };
export type GatewayCaller = SignedInGatewayCaller | AnonymousGatewayCaller | RejectedGatewayCaller;

/**
 * Who an inference request runs as. A presented credential that failed
 * verification is never downgraded to anonymous; see `invalidTokenResponse`.
 *
 * `passThroughAuthFailure` returns any other auth failure as is, such as the 403
 * for a blocked user or a non-member, instead of the sign-in prompt.
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
    };
  }
  if (auth.rejectionReason === 'empty_organization_context') {
    return { kind: 'rejected', response: auth.authFailedResponse };
  }
  if (auth.credentialsRejected) return { kind: 'rejected', response: invalidTokenResponse() };
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
  model: string
): Promise<BalanceAndOrgSettings> {
  return getBalanceAndOrgSettings(
    organizationId,
    user,
    readDb,
    isFreeModel(model) ? undefined : 'usage'
  );
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
 * Holds a request's maximum cost against the payer before the upstream call, so
 * the payer's in-flight cost stays inside the balance this request read.
 *
 * A request the catalog cannot bound holds nothing and keeps the
 * positive-balance admission it had. A reservation store that does not answer
 * also holds nothing: an unavailable store must not refuse a request the balance
 * check admitted.
 */
export async function admitGatewaySpend(params: {
  user: Pick<User, 'id'>;
  organizationId: string | undefined;
  /** The usage id the request's debit will carry, which keys the hold. */
  usageId: string;
  account: Pick<BalanceAndOrgSettings, 'balance'>;
  maximumCostMicrodollars: number | null;
  model: string;
}): Promise<SpendAdmission> {
  const { user, organizationId, usageId, account, maximumCostMicrodollars } = params;
  if (maximumCostMicrodollars === null) {
    reportUnboundedRequest(params.model);
    return { kind: 'admitted', release: null };
  }
  const reservation = await reservePaidSpend({
    usageId,
    payer: { organizationId, userId: user.id },
    amountMicrodollars: maximumCostMicrodollars,
    availableMicrodollars: Math.floor(account.balance * 1_000_000),
  });
  if (reservation.kind === 'insufficient') return { kind: 'insufficient' };
  return {
    kind: 'admitted',
    release: reservation.kind === 'reserved' ? reservation.release : null,
  };
}

/** One report a model a minute raises the alarm without flooding when the catalog has a gap. */
const UNBOUNDED_REPORT_INTERVAL_MS = 60_000;
const lastUnboundedReportAt = new Map<string, number>();

function reportUnboundedRequest(model: string): void {
  const now = Date.now();
  if (now - (lastUnboundedReportAt.get(model) ?? 0) < UNBOUNDED_REPORT_INTERVAL_MS) return;
  lastUnboundedReportAt.set(model, now);
  captureMessage('Gateway request has no maximum cost bound', {
    level: 'warning',
    tags: { source: 'gateway_spend_admission' },
    extra: { model },
  });
}

/**
 * The provider preferences the organization requires: its data collection
 * policy and the member decision's provider routes, with the request's own
 * privacy merged in. `provider` is undefined when the organization requires
 * neither, so the request's provider preferences stand.
 */
export function organizationProviderPreferences(params: {
  decision: EffectiveModelDecision | undefined;
  settings: OrganizationSettings | undefined;
  requestProvider: Pick<OpenRouterProviderConfig, 'data_collection' | 'zdr'> | undefined;
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
  return {
    kind: 'allowed',
    provider: {
      ...organizationPrivacy,
      ...getEffectiveProviderPrivacy(requestProvider, settings?.data_collection),
      ...(only && { only }),
    },
  };
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
