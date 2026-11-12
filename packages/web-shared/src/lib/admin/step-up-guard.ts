import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  StepUpRequiredError,
  type AdminStepUpState,
  type PrivilegedActionClass,
  type PrivilegedCredentialKind,
  type PrivilegedTarget,
  type StepUpErrorCode,
  type StepUpRequirementPayload,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import {
  isOperationStepUpClass,
  stepUpPolicyFor,
} from '@kilocode/web-shared/lib/admin/step-up-policy';
import {
  stepUpBindingFromOperation,
  type StepUpOperation,
  type StepUpSurface,
} from '@kilocode/web-shared/lib/admin/step-up-binding';
import { evaluateStepUp } from '@kilocode/web-shared/lib/admin/step-up-store';
import { reportStepUpFailure } from '@kilocode/web-shared/lib/admin/step-up-observation';

export type RunStepUpGuardParams = {
  userId: string;
  credential: PrivilegedCredentialKind;
  webSessionId?: string | null;
  actionClass: PrivilegedActionClass;
  /** The target account or organization this request acts on, when known. */
  target: PrivilegedTarget;
  enabled: boolean;
  route: string | null;
  method: string | null;
  surface: StepUpSurface;
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
 * The operation a guard call authorizes. An operation-class refusal carries
 * this value so the admin UI mints a proof for the same action instead of a
 * generic one.
 */
export function stepUpOperationFor(params: {
  actionClass: PrivilegedActionClass;
  route: string | null;
  method: string | null;
  surface: StepUpSurface;
  target: PrivilegedTarget;
}): StepUpOperation {
  return {
    surface: params.surface,
    route: params.route ?? '',
    method: (params.method ?? '').toLowerCase(),
    target: params.target,
  };
}

function deny(params: {
  code: StepUpErrorCode;
  actionClass: PrivilegedActionClass;
  operation: StepUpOperation;
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
      binding: isOperationStepUpClass(params.actionClass)
        ? stepUpBindingFromOperation(params.actionClass, params.operation)
        : null,
    }),
  });
}

/**
 * The client-visible detail of a step-up refusal, for a REST response body. The
 * admin dialog echoes the binding back, so the refusal must name the operation.
 */
export function stepUpRefusalPayload(cause: StepUpRequiredError): StepUpRequirementPayload {
  return {
    code: cause.code,
    actionClass: cause.actionClass,
    purpose: cause.purpose,
    maxAgeSeconds: cause.maxAgeSeconds,
    binding: cause.binding,
  };
}

/**
 * Enforce step-up for one request when the switch is on. With the switch off
 * this performs no reads and changes nothing.
 *
 * A session-class request is satisfied by any live session proof. An
 * operation-class request claims the single proof minted for this exact action
 * class and operation, so it can be used once.
 *
 * Failures:
 * - non-session credential → BEARER_NOT_ALLOWED
 * - no live proof → MFA_REQUIRED / MFA_EXPIRED / NOT_ENROLLED / SESSION_UNBOUND
 * - evaluation or persistence error → STEP_UP_UNAVAILABLE (fail closed)
 */
export async function runStepUpGuard(params: RunStepUpGuardParams): Promise<AdminStepUpState> {
  if (!params.enabled) return { status: 'absent' };

  const operation = stepUpOperationFor({
    actionClass: params.actionClass,
    route: params.route,
    method: params.method,
    surface: params.surface,
    target: params.target,
  });

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
