import 'server-only';
import { TRPCError } from '@trpc/server';
import {
  StepUpRequiredError,
  type AdminStepUpDecision,
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
  normalizeStepUpMethod,
  stepUpBindingFromOperation,
  stepUpOperationSchema,
  type StepUpOperation,
  type StepUpOperationBinding,
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
 * The binding a refusal carries, which the admin UI echoes back to mint and
 * verify the proof. The client parses it with `stepUpOperationSchema` before it
 * sends it, and the challenge endpoint parses it again, so build it through the
 * same schema: a refusal whose descriptor the boundary rejects would prompt for
 * an operation the caller cannot confirm.
 */
function refusalBinding(
  actionClass: PrivilegedActionClass,
  operation: StepUpOperation
): StepUpOperationBinding {
  const parsed = stepUpOperationSchema.safeParse(
    stepUpBindingFromOperation(actionClass, operation)
  );
  if (!parsed.success) {
    throw new Error('An operation step-up binding must be one the client can submit');
  }
  return parsed.data;
}

/**
 * The operation a guard call authorizes. An operation-class refusal carries
 * this value so the admin UI mints a proof for the same action instead of a
 * generic one.
 *
 * An operation-class request whose operation does not yield a submittable
 * binding is a wiring error, not a refusal: the admin UI echoes the refusal
 * binding back and the boundary schema bounds it, so no proof could ever be
 * minted for it and no retried request could ever match one. Throw before
 * anything is measured, exactly as a missing operation itself does.
 */
export function stepUpOperationFor(params: {
  actionClass: PrivilegedActionClass;
  route: string | null;
  method: string | null;
  surface: StepUpSurface;
  target: PrivilegedTarget;
}): StepUpOperation {
  const operation: StepUpOperation = {
    surface: params.surface,
    route: params.route ?? '',
    method: normalizeStepUpMethod(params.method ?? ''),
    target: params.target,
  };
  if (isOperationStepUpClass(params.actionClass)) {
    refusalBinding(params.actionClass, operation);
  }
  return operation;
}

/**
 * Whether the admin middleware's decision covers the action and target a
 * specialized guard is about to act on.
 *
 * An operation-class decision covers a request that names the same target kind
 * and the same target id. A decision with no target id covers a request that
 * names none; a request that names a target needs a decision that names it.
 */
export function stepUpDecisionCovers(
  decision: AdminStepUpDecision | undefined,
  actionClass: PrivilegedActionClass,
  target: PrivilegedTarget
): boolean {
  if (!decision) return false;
  if (decision.actionClass !== actionClass) return false;
  if (!isOperationStepUpClass(actionClass)) return true;
  // A caller that names no target accepts the decision the middleware
  // measured, which is at least as specific.
  if (target.kind === 'none' && target.id === null) return true;
  if (decision.target.kind !== target.kind) return false;
  return decision.target.id === target.id;
}

function deny(params: {
  code: StepUpErrorCode;
  actionClass: PrivilegedActionClass;
  /** The operation a retry must name, when the refusal can name one. */
  operation: StepUpOperation | null;
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
      binding:
        params.operation && isOperationStepUpClass(params.actionClass)
          ? refusalBinding(params.actionClass, params.operation)
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

  // A bearer credential can never complete step-up, whatever operation it
  // names, so refuse it before the operation is resolved: its reason must not
  // depend on whether the caller also knows its route and method.
  if (params.credential !== 'session') {
    deny({
      code: 'BEARER_NOT_ALLOWED',
      actionClass: params.actionClass,
      operation: null,
      message: 'MFA requires a browser session',
    });
  }

  const operation = stepUpOperationFor({
    actionClass: params.actionClass,
    route: params.route,
    method: params.method,
    surface: params.surface,
    target: params.target,
  });

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
