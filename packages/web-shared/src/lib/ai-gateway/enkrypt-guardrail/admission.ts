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
  enkryptInputGuardrailAppliesTo,
  enkryptInputGuardrailGroupId,
  resolveEnkryptInputGuardrail,
  resolveEnkryptOutputGuardrail,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
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
 * A guardrail limited to a group applies when the member's groups cannot be read, so a failed
 * lookup scans rather than letting requests through unchecked.
 */
async function isInEnkryptInputGuardrailGroup(
  organizationId: string,
  settings: BalanceAndOrgSettings['settings'],
  memberGroupIds: () => Promise<readonly string[]>
): Promise<boolean> {
  if (enkryptInputGuardrailGroupId(settings) === null) return true;
  try {
    return enkryptInputGuardrailAppliesTo(settings, await memberGroupIds());
  } catch (error) {
    warnExceptInTest('[enkrypt-guardrail] member groups unavailable; scanning the request', {
      organization_id: organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/**
 * An organization with an input or output guardrail must have a positive balance before Enkrypt is
 * called, even when the request itself is free, BYOK, or exempt from paid-usage checks. The check
 * uses the organization balance, not the member's allowance. An input guardrail limited to a group
 * that the member is not in does not apply to them.
 */
export async function admitEnkryptGuardrail(
  caller: GatewayCaller,
  account: Pick<BalanceAndOrgSettings, 'settings' | 'payer'>,
  memberGroupIds: () => Promise<readonly string[]>
): Promise<EnkryptGuardrailAdmission> {
  if (caller.kind !== 'signed-in' || !caller.organizationId) {
    return { kind: 'admitted', inputGuardrail: null };
  }
  const { organizationId, user } = caller;
  const resolvedInputConfig = resolveEnkryptInputGuardrail(organizationId, account.settings);
  const inputConfig =
    resolvedInputConfig &&
    (await isInEnkryptInputGuardrailGroup(organizationId, account.settings, memberGroupIds))
      ? resolvedInputConfig
      : null;
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
