import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  StepUpRequiredError,
  type AdminStepUpState,
  type PrivilegedActionClass,
  type PrivilegedCredentialKind,
  type StepUpErrorCode,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import { stepUpPolicyFor } from '@kilocode/web-shared/lib/admin/step-up-policy';
import {
  evaluateStepUp,
  type StepUpActionBinding,
} from '@kilocode/web-shared/lib/admin/step-up-store';
import { emitStepUpObservation } from '@kilocode/web-shared/lib/admin/step-up-observation';
import type { AdminStepUpMode } from '@kilocode/web-shared/lib/config.server';

export type RunStepUpGuardParams = {
  userId: string;
  credential: PrivilegedCredentialKind;
  webSessionId?: string | null;
  actionClass: PrivilegedActionClass;
  actionBinding?: StepUpActionBinding | null;
  mode: AdminStepUpMode;
  route: string | null;
  method: string | null;
  surface: 'rest' | 'trpc' | 'server-component';
};

function codeForState(state: AdminStepUpState): StepUpErrorCode {
  switch (state.status) {
    case 'session_unbound':
      return 'SESSION_UNBOUND';
    case 'not_enrolled':
      return 'NOT_ENROLLED';
    case 'expired':
      return 'MFA_EXPIRED';
    case 'fresh':
      return 'MFA_REQUIRED';
    case 'required':
    case 'absent':
      return 'MFA_REQUIRED';
  }
}

/**
 * Observe or enforce session step-up for one request.
 *
 * `off` performs no database read and no telemetry. `observe` measures and
 * emits, and never denies. `enforce` throws FORBIDDEN with a
 * {@link StepUpRequiredError} cause; PR2 clamps config to `observe`, so only an
 * internal test seam can reach it.
 */
export async function runStepUpGuard(params: RunStepUpGuardParams): Promise<AdminStepUpState> {
  if (params.mode === 'off') return { status: 'absent' };

  let state: AdminStepUpState;
  if (params.credential !== 'session') {
    state = { status: 'session_unbound' };
  } else {
    const evaluation = await evaluateStepUp({
      userId: params.userId,
      webSessionId: params.webSessionId,
      actionClass: params.actionClass,
      actionBinding: params.actionBinding,
    });
    state = evaluation.state;
  }

  emitStepUpObservation({
    surface: params.surface,
    kiloUserId: params.userId,
    credential: params.credential,
    actionClass: params.actionClass,
    state,
    mode: params.mode,
    route: params.route,
    method: params.method,
  });

  if (params.mode === 'enforce' && state.status !== 'fresh') {
    const policy = stepUpPolicyFor(params.actionClass);
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'MFA is required for this action',
      cause: new StepUpRequiredError({
        code: params.credential !== 'session' ? 'BEARER_NOT_ALLOWED' : codeForState(state),
        actionClass: params.actionClass,
        purpose: policy.purpose,
        maxAgeSeconds: Math.round(policy.maxAgeMs / 1000),
      }),
    });
  }

  return state;
}
