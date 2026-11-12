import 'server-only';

import { TRPCError } from '@trpc/server';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { runStepUpGuard } from '@kilocode/web-shared/lib/admin/step-up-guard';
import {
  isOperationStepUpClass,
  stepUpPolicyFor,
} from '@kilocode/web-shared/lib/admin/step-up-policy';
import type {
  SupportActionClass,
  SupportStepUpPort,
} from '@kilocode/web-shared/lib/admin/support-access';

function refuse(actionClass: SupportActionClass): never {
  const policy = stepUpPolicyFor(actionClass);
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Step-up must be enabled for this support access change',
    cause: new StepUpRequiredError({
      code: 'MFA_REQUIRED',
      actionClass,
      purpose: policy.purpose,
      maxAgeSeconds: Math.round(policy.maxAgeMs / 1000),
    }),
  });
}

/**
 * Step-up for support access changes.
 *
 * A support write needs a passkey proof minted for that one write against that
 * one organization, and the guard spends it. That requirement does not depend
 * on `ADMIN_STEP_UP_ENABLED`: with the switch off a support write is refused
 * rather than allowed without a proof.
 *
 * A support read grant only needs a live session proof, exactly like the other
 * session-class actions, and it is skipped while the switch is off.
 *
 * A missing credential is treated as non-session, so bearer or unknown callers
 * are refused rather than silently assumed to have a passkey.
 */
export const supportStepUpPort: SupportStepUpPort = {
  async requireFresh(params) {
    const enabled = isAdminStepUpEnabled();
    if (!enabled && isOperationStepUpClass(params.actionClass)) {
      refuse(params.actionClass);
    }
    if (!enabled) return;

    await runStepUpGuard({
      userId: params.userId,
      credential: params.credential ?? 'human_bearer',
      webSessionId: params.webSessionId ?? null,
      actionClass: params.actionClass,
      target: { kind: 'organization', id: params.organizationId },
      enabled: true,
      route: params.route ?? null,
      method: params.method ?? null,
      surface: params.surface ?? 'trpc',
    });
  },
};
