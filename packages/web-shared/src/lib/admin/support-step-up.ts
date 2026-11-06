import 'server-only';

import { TRPCError } from '@trpc/server';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { runStepUpGuard } from '@kilocode/web-shared/lib/admin/step-up-guard';
import { stepUpPolicyFor } from '@kilocode/web-shared/lib/admin/step-up-policy';
import type { SupportStepUpPort } from '@kilocode/web-shared/lib/admin/support-access';

/**
 * Support write authority requires a fresh session-bound passkey proof. Unlike
 * the general admin guard, this is not gated on `ADMIN_STEP_UP_ENABLED`: when
 * that switch is off, support writes are refused rather than silently allowed
 * without a proof.
 */
export const supportStepUpPort: SupportStepUpPort = {
  async requireFresh(params) {
    if (!isAdminStepUpEnabled()) {
      const policy = stepUpPolicyFor('platform_write');
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Step-up must be enabled to issue or approve support write access',
        cause: new StepUpRequiredError({
          code: 'MFA_REQUIRED',
          actionClass: 'platform_write',
          purpose: policy.purpose,
          maxAgeSeconds: Math.round(policy.maxAgeMs / 1000),
        }),
      });
    }

    // A missing credential is treated as non-session, so bearer or unknown
    // callers are refused rather than silently assumed to have a passkey.
    await runStepUpGuard({
      userId: params.userId,
      credential: params.credential ?? 'human_bearer',
      webSessionId: params.webSessionId ?? null,
      actionClass: 'platform_write',
      enabled: true,
      route: params.route ?? null,
      method: params.method ?? null,
      surface: params.surface ?? 'trpc',
    });
  },
};
