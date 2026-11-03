import type { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
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
import type { EffectiveModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import type { OpenRouterProviderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { withoutVirtualProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/virtual-models';
import {
  creditsBlockedResponse,
  getOrganizationProviderPrivacy,
  invalidTokenResponse,
  modelNotAllowedResponse,
  paidModelAuthRequiredResponse,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';

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
  if (auth.credentialsRejected) return { kind: 'rejected', response: invalidTokenResponse() };
  if (opts.passThroughAuthFailure) return { kind: 'rejected', response: auth.authFailedResponse };
  if (opts.allowAnonymous && opts.ipAddress) {
    return { kind: 'anonymous', user: createAnonymousContext(opts.ipAddress) };
  }
  return { kind: 'rejected', response: paidModelAuthRequiredResponse() };
}

/** Free models are not usage-funded, so reading their balance skips auto top-up. */
export async function readGatewayBalance(
  user: User,
  organizationId: string | undefined,
  model: string
): Promise<BalanceAndOrgSettings> {
  return await getBalanceAndOrgSettings(
    organizationId,
    user,
    readDb,
    (await isFreeModel(model)) ? undefined : 'usage'
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
