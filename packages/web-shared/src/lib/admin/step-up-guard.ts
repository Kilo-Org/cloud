import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  StepUpRequiredError,
  type AdminStepUpState,
  type PrivilegedActionClass,
  type PrivilegedCredentialKind,
  type PrivilegedTarget,
  type StepUpErrorCode,
  type StepUpOperation,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  stepUpIsOperationClass,
  stepUpPolicyFor,
} from '@kilocode/web-shared/lib/admin/step-up-policy';
import { stepUpOperationFor } from '@kilocode/web-shared/lib/admin/privileged-inventory';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';

export type RunStepUpGuardParams = {
  userId: string;
  credential: PrivilegedCredentialKind;
  webSessionId?: string | null;
  actionClass: PrivilegedActionClass;
  /** The inventory id resolved for this route, when one matched. */
  inventoryId?: string | null;
  /** A concrete target the caller knows; the inventory target kind is the fallback. */
  target?: PrivilegedTarget;
  enabled: boolean;
  route: string | null;
  method: string | null;
  surface: 'rest' | 'trpc' | 'server-component';
};

export function stepUpErrorCodeForState(state: AdminStepUpState): StepUpErrorCode {
  switch (state.status) {
    case 'session_unbound':
      return 'SESSION_UNBOUND';
    case 'not_enrolled':
      return 'NOT_ENROLLED';
    case 'expired':
    case 'revoked':
      return 'MFA_EXPIRED';
    case 'fresh':
      return 'MFA_REQUIRED';
    case 'required':
    case 'absent':
      return 'MFA_REQUIRED';
  }
}

/**
 * The operation a refusal tells the client to verify. A session class carries
 * none, because any fresh session proof satisfies it.
 */
export function stepUpOperationForGuard(
  params: Pick<
    RunStepUpGuardParams,
    'actionClass' | 'route' | 'method' | 'surface' | 'inventoryId' | 'target'
  >
): StepUpOperation | undefined {
  if (!stepUpIsOperationClass(params.actionClass)) return undefined;
  return stepUpOperationFor({
    surface: params.surface,
    route: params.route,
    method: params.method,
    inventoryId: params.inventoryId,
    target: params.target,
  });
}

function deny(params: {
  code: StepUpErrorCode;
  actionClass: PrivilegedActionClass;
  operation?: StepUpOperation;
  message: string;
}): never {
  const policy = stepUpPolicyFor(params.actionClass);
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: params.message,
    cause: new StepUpRequiredError({
      code: params.code,
      actionClass: params.actionClass,
      purpose: policy.purpose,
      maxAgeSeconds: Math.round(policy.maxAgeMs / 1000),
      operation: params.operation ?? null,
    }),
  });
}

/**
 * Enforce session step-up for one request when the switch is on. With the
 * switch off this performs no reads and changes nothing.
 *
 * A session class accepts the reusable session proof. An operation class
 * (`sensitive_write`, `support_write`, `worker_admin`) needs the proof bound to
 * this operation and target, and spends it on this request.
 *
 * Failures:
 * - non-session credential → BEARER_NOT_ALLOWED
 * - no live proof → MFA_REQUIRED / MFA_EXPIRED / NOT_ENROLLED / SESSION_UNBOUND
 * - evaluation or persistence error → STEP_UP_UNAVAILABLE (fail closed)
 */
export async function runStepUpGuard(params: RunStepUpGuardParams): Promise<AdminStepUpState> {
  if (!params.enabled) return { status: 'absent' };

  const operation = stepUpOperationForGuard(params);

  if (params.credential !== 'session') {
    deny({
      code: 'BEARER_NOT_ALLOWED',
      actionClass: params.actionClass,
      operation,
      message: 'MFA requires a browser session',
    });
  }

  let state: AdminStepUpState;
  try {
    const evaluation = await evaluateStepUp({
      userId: params.userId,
      webSessionId: params.webSessionId,
      actionClass: params.actionClass,
      operation,
    });
    state = evaluation.state;
  } catch (error) {
    reportStepUpFailure('admin_step_up_evaluate', error);
    deny({
      code: 'STEP_UP_UNAVAILABLE',
      actionClass: params.actionClass,
      operation,
      message: 'MFA verification is temporarily unavailable',
    });
  }

  if (state.status !== 'fresh') {
    deny({
      code: stepUpErrorCodeForState(state),
      actionClass: params.actionClass,
      operation,
      message: 'MFA is required for this action',
    });
  }

  return state;
}
