import { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { modelNotAllowedResponse } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import type { BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  admitGatewaySpend,
  paidUsageRejection,
  readGatewayBalance,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

export type DirectProviderAccessResult =
  | { rejection: NextResponse; access?: never }
  | {
      rejection?: never;
      access: Pick<BalanceAndOrgSettings, 'balance' | 'plan' | 'payer'> & {
        /** Gives back the spend this request holds; null when nothing was held. */
        releaseSpend: (() => Promise<void>) | null;
      };
    };

/** Answered without the full credits response, which reads payment and top-up state. */
function insufficientCreditsResponse() {
  return NextResponse.json(
    {
      error: { message: 'Insufficient credits' },
      error_type: ProxyErrorType.insufficient_credits,
    },
    { status: 402 }
  );
}

export async function checkDirectProviderAccess(params: {
  user: User;
  organizationId: string | undefined;
  model: string;
  provider: string;
  isFreeUsage: boolean;
  hasByok: boolean;
  /** The usage id this request will bill under, which keys its spend hold. */
  usageId: string;
  /** The request's priced maximum cost, or null when it cannot be bounded. */
  maximumCostMicrodollars: number | null;
}): Promise<DirectProviderAccessResult> {
  const { user, organizationId, model, provider } = params;
  const account = await readGatewayBalance(user, organizationId, model);
  const { balance, plan, payer } = account;
  const exempt = params.isFreeUsage || params.hasByok;

  if (paidUsageRejection({ user, organizationId, account, exempt })) {
    return { rejection: insufficientCreditsResponse() };
  }

  if (organizationId) {
    const { decision } = await resolveOrganizationMemberModelDecision({
      organizationId,
      kiloUserId: user.id,
      modelId: model,
      fromDb: readDb,
    });
    if (
      !decision.allowed ||
      (decision.eligibleProviderRoutes && !decision.eligibleProviderRoutes.has(provider))
    ) {
      return { rejection: modelNotAllowedResponse() };
    }
  }

  // Last, so the hold covers the upstream call and nothing else.
  if (exempt) return { access: { balance, plan, payer, releaseSpend: null } };
  const spendAdmission = await admitGatewaySpend({
    user,
    organizationId,
    usageId: params.usageId,
    account,
    maximumCostMicrodollars: params.maximumCostMicrodollars,
    model,
  });
  if (spendAdmission.kind === 'insufficient') {
    return { rejection: insufficientCreditsResponse() };
  }
  return { access: { balance, plan, payer, releaseSpend: spendAdmission.release } };
}
