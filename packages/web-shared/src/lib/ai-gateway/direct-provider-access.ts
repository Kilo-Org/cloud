import { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { modelNotAllowedResponse } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import type { BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import {
  paidUsageRejection,
  readGatewayBalance,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';

export type DirectProviderAccessResult =
  | { rejection: NextResponse; access?: never }
  | {
      rejection?: never;
      access: Pick<BalanceAndOrgSettings, 'balance' | 'plan' | 'payer'>;
    };

export async function checkDirectProviderAccess(params: {
  user: User;
  organizationId: string | undefined;
  model: string;
  provider: string;
  isFreeUsage: boolean;
  hasByok: boolean;
}): Promise<DirectProviderAccessResult> {
  const { user, organizationId, model, provider } = params;
  const account = await readGatewayBalance(user, organizationId, model);
  const { balance, plan, payer } = account;

  // Answered without the full credits response, which reads payment and top-up
  // state, to keep this high-volume autocomplete path cheap.
  if (
    paidUsageRejection({
      user,
      organizationId,
      account,
      exempt: params.isFreeUsage || params.hasByok,
    })
  ) {
    return {
      rejection: NextResponse.json(
        {
          error: { message: 'Insufficient credits' },
          error_type: ProxyErrorType.insufficient_credits,
        },
        { status: 402 }
      ),
    };
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

  return { access: { balance, plan, payer } };
}
