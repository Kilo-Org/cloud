import 'server-only';

import type { NextResponse } from 'next/server';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { accountBalanceMicrodollars } from '@kilocode/worker-utils/account-access';
import { isAutoTopUpInFlight } from '@kilocode/web-shared/lib/autoTopUpInFlight';
import { topUpInProgressResponse } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type { GatewayCaller } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import type {
  BalanceAndOrgSettings,
  BalancePayer,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { enkryptOrganizationCreditsRequiredResponse } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/responses';
import {
  resolveEnkryptInputGuardrail,
  resolveEnkryptOutputGuardrail,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import type { EnkryptGuardrailRequest } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/verdict-cache';

export type EnkryptInputGuardrailScope = Pick<
  EnkryptGuardrailRequest,
  'organizationId' | 'kiloUserId' | 'config'
>;

export type EnkryptGuardrailAdmission =
  | { kind: 'admitted'; inputGuardrail: EnkryptInputGuardrailScope | null }
  | { kind: 'rejected'; response: NextResponse };

function organizationBalanceMicrodollars(payer: BalancePayer | undefined): number {
  if (!payer) return 0;
  return accountBalanceMicrodollars({
    total_microdollars_acquired: payer.totalMicrodollarsAcquired,
    microdollars_used: payer.microdollarsUsed,
  });
}

/**
 * An organization with an input or output guardrail must have a positive balance before Enkrypt is
 * called, even when the request itself is free, BYOK, or exempt from paid-usage checks. The check
 * uses the organization balance, not the member's allowance.
 */
export async function admitEnkryptGuardrail(
  caller: GatewayCaller,
  account: Pick<BalanceAndOrgSettings, 'settings' | 'payer'>
): Promise<EnkryptGuardrailAdmission> {
  if (caller.kind !== 'signed-in' || !caller.organizationId) {
    return { kind: 'admitted', inputGuardrail: null };
  }
  const { organizationId, user } = caller;
  const inputConfig = resolveEnkryptInputGuardrail(organizationId, account.settings);
  const isGuarded =
    inputConfig !== null ||
    resolveEnkryptOutputGuardrail(organizationId, account.settings) !== null;
  const balanceMicrodollars = organizationBalanceMicrodollars(account.payer);
  if (isGuarded && balanceMicrodollars <= 0) {
    const response = (await isAutoTopUpInFlight({ userId: user.id, organizationId }))
      ? topUpInProgressResponse()
      : enkryptOrganizationCreditsRequiredResponse(
          organizationId,
          fromMicrodollars(balanceMicrodollars)
        );
    return { kind: 'rejected', response };
  }
  return {
    kind: 'admitted',
    inputGuardrail: inputConfig && { organizationId, kiloUserId: user.id, config: inputConfig },
  };
}
