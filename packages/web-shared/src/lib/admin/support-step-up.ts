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
 * A support write proof is single-use and bound to the exact operation that
 * minted it, so one request gets exactly one claim. On an `adminProcedure`
 * mutation the middleware has already claimed and spent a proof for the exact
 * tRPC route before the resolver runs. Claiming again here would bind a second
 * proof to the concrete organization instead, so the two claims could never
 * converge: each retry would answer one prompt and demand the other, and the
 * write would never complete.
 *
 * Therefore a fresh upstream state means this request already confirmed this
 * operation and is reused as-is; the organization is still written to the
 * audit record by the caller, it is just not part of the proof on this path.
 * Without an upstream state (a caller that is not on `adminProcedure`, or a
 * REST or server-component surface) the use claims a proof of its own, bound
 * to the organization it acts on.
 *
 * With the switch off the write is still refused: the reuse path must not
 * become a way to spend an operation grant without step-up enabled.
 */
export async function requireSupportWriteUseStepUp(params: {
  userId: string;
  organizationId: string;
  /** The state the upstream guard left on the context, when one ran. */
  upstreamStepUpState?: AdminStepUpState;
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
}
