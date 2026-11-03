import { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { canSpendPaidUsage } from '@kilocode/worker-utils/account-access';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { modelNotAllowedResponse } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import {
  getBalanceAndOrgSettings,
  type BalanceAndOrgSettings,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';

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
  const freeRequest = await isFreeModel(model);
  const { balance, plan, payer } = await getBalanceAndOrgSettings(
    organizationId,
    user,
    readDb,
    freeRequest ? undefined : 'usage'
  );

  if (!canSpendPaidUsage(balance) && !params.isFreeUsage && !params.hasByok) {
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
