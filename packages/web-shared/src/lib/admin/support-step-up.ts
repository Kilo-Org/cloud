import 'server-only';

import { TRPCError } from '@trpc/server';
import { isAdminStepUpEnabled } from '@kilocode/web-shared/lib/config.server';
import {
  StepUpRequiredError,
  type AdminStepUpState,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { runStepUpGuard } from '@kilocode/web-shared/lib/admin/step-up-guard';
import {
  isOperationStepUpClass,
  stepUpPolicyFor,
} from '@kilocode/web-shared/lib/admin/step-up-policy';
import type {
  SupportActionClass,
  SupportStepUpCredential,
  SupportStepUpPort,
  SupportSurface,
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

/**
 * Step-up for a use of an already-issued support write grant.
 *
 * With the switch off a support write is still refused.
 */
export async function requireSupportWriteUseStepUp(params: {
  userId: string;
  organizationId: string;
  /** The state the upstream guard left on the context, when one ran. */
  upstreamStepUpState?: AdminStepUpState;
  /**
   * The request's claim set (`TRPCContext.stepUpClaims`). It is one mutable
   * value per request, which tRPC keeps across the context copies its
   * middleware makes.
   */
  claimStore?: Set<string>;
  /** The operation this request is confirming, as it appears in the set. */
  claimKey?: string;
  credential?: SupportStepUpCredential;
  webSessionId?: string | null;
  route?: string | null;
  method?: string | null;
  surface?: SupportSurface;
}): Promise<void> {
  if (!isAdminStepUpEnabled()) {
    refuse('support_write');
  }
  if (params.upstreamStepUpState?.status === 'fresh') return;
  if (params.claimStore && params.claimKey && params.claimStore.has(params.claimKey)) return;

  await supportStepUpPort.requireFresh({
    userId: params.userId,
    action: 'support_write_use',
    actionClass: 'support_write',
    organizationId: params.organizationId,
    credential: params.credential,
    webSessionId: params.webSessionId ?? null,
    route: params.route ?? null,
    method: params.method ?? null,
    surface: params.surface ?? 'trpc',
  });

  if (params.claimStore && params.claimKey) params.claimStore.add(params.claimKey);
}
