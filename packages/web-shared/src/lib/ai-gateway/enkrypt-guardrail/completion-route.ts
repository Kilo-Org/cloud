import 'server-only';

import type { NextResponse } from 'next/server';
import type { EnkryptGuardrailApiKind } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { BalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import type { GatewayCaller } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';
import { admitEnkryptGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/admission';
import { startEnkryptInputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/input-guardrail';
import {
  resolveEnkryptOutputScan,
  type EnkryptOutputScan,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/output-guardrail';
import { enkryptGuardrailRejectionResponse } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/responses';
import type { RequestScanParts } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/request-text';

/** The completion routes that carry one member-authored prompt and enforce the guardrail. */
export type CompletionRouteApiKind = Extract<
  EnkryptGuardrailApiKind,
  'edit_completions' | 'fim_completions'
>;

export type CompletionRouteGuardrail =
  | { kind: 'rejected'; response: NextResponse }
  | {
      kind: 'admitted';
      /**
       * Awaited immediately before the upstream call: the rejection to return, or null to send the
       * request. Log-only detectors never delay or reject it.
       */
      rejectIfBlocked(): Promise<NextResponse | null>;
      /** The response scan this organization's output guardrail resolves to, or null without one. */
      outputScan: EnkryptOutputScan | null;
    };

/**
 * The organization guardrail admission and input scan for a completion route, in the order the chat
 * route applies them: admit first (a guarded organization needs a positive organization balance,
 * even for a free or BYOK request), then scan the prompt while the rest of the route prepares its
 * access checks. `rejectIfBlocked` waits for the blocking verdict where the chat route does, just
 * before the upstream call.
 */
export async function admitCompletionRouteGuardrail(input: {
  caller: GatewayCaller;
  /** The account `checkDirectProviderAccess` already read for this request. */
  account: Pick<BalanceAndOrgSettings, 'settings' | 'payer'>;
  organizationId: string | undefined;
  kiloUserId: string;
  apiKind: CompletionRouteApiKind;
  sessionId: string | null;
  clientRequestId: string | null;
  parts: RequestScanParts;
  signal: AbortSignal;
}): Promise<CompletionRouteGuardrail> {
  const admission = await admitEnkryptGuardrail(input.caller, input.account, () =>
    memberGroupIds(input.organizationId, input.kiloUserId)
  );
  if (admission.kind === 'rejected') return admission;

  const guardrail = startEnkryptInputGuardrail(
    Promise.resolve(admission.inputGuardrail).then(
      scope =>
        scope && {
          ...scope,
          sessionId: input.sessionId,
          apiKind: input.apiKind,
          clientRequestId: input.clientRequestId,
          parts: input.parts,
        }
    ),
    input.signal
  );

  return {
    kind: 'admitted',
    rejectIfBlocked: async () =>
      enkryptGuardrailRejectionResponse(input.apiKind, await guardrail.awaitVerdict()),
    outputScan: input.organizationId
      ? resolveEnkryptOutputScan(
          {
            sessionId: input.sessionId,
            organizationId: input.organizationId,
            kiloUserId: input.kiloUserId,
            apiKind: input.apiKind,
            clientRequestId: input.clientRequestId,
          },
          input.account.settings
        )
      : null,
  };
}

/**
 * The member's organization group ids, which scope a group-limited input guardrail. The admission
 * only awaits this when the guardrail names a group, so an organization-wide guardrail costs no
 * extra query.
 */
function memberGroupIds(
  organizationId: string | undefined,
  kiloUserId: string
): Promise<readonly string[]> {
  if (!organizationId) return Promise.resolve([]);
  return getOrganizationGroupPolicyContext({
    organizationId,
    subject: { type: 'member', kiloUserId },
    fromDb: readDb,
  }).then(context => context.groupIds);
}
