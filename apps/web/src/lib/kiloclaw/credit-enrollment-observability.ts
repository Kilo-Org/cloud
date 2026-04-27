import 'server-only';

export const CREDIT_ENROLLMENT_BILLING_FLOW = 'credit_enrollment' as const;
const CREDIT_ENROLLMENT_BILLING_COMPONENT = 'web_trpc' as const;

export type CreditEnrollmentFailureReason =
  | 'insufficient_credits'
  | 'duplicate_enrollment'
  | 'active_subscription_exists'
  | 'no_instance'
  | 'user_not_found'
  | 'precondition_failed'
  | 'internal_error';

type BaseFields = {
  userId: string;
  plan: 'commit' | 'standard';
  instanceId?: string;
};

type AttemptedFields = BaseFields;

type SucceededFields = BaseFields & {
  instanceId: string;
  durationMs: number;
};

type FailedFields = BaseFields & {
  failureReason: CreditEnrollmentFailureReason;
  durationMs: number;
  error?: string;
};

// Cap on the error field's length. Upstream error messages are not guaranteed
// to be free of identifying values (IDs, parameter snippets from ORM/driver
// errors), so truncation limits the blast radius in log storage.
const ERROR_FIELD_MAX_LENGTH = 500;

function emit(level: 'info' | 'error', record: Record<string, unknown>): void {
  // Fixed fields are spread last so callers cannot shadow level, billingFlow,
  // or billingComponent via a colliding key in `record`.
  const line = JSON.stringify({
    ...record,
    level,
    billingFlow: CREDIT_ENROLLMENT_BILLING_FLOW,
    billingComponent: CREDIT_ENROLLMENT_BILLING_COMPONENT,
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function logCreditEnrollmentAttempted(fields: AttemptedFields): void {
  emit('info', {
    ...fields,
    event: 'credit_enrollment.attempted',
    outcome: 'started',
  });
}

export function logCreditEnrollmentSucceeded(fields: SucceededFields): void {
  emit('info', {
    ...fields,
    event: 'credit_enrollment.succeeded',
    outcome: 'completed',
  });
}

export function logCreditEnrollmentFailed(fields: FailedFields): void {
  const { error, ...rest } = fields;
  const level = rest.failureReason === 'internal_error' ? 'error' : 'info';
  const truncatedError =
    error !== undefined && error.length > ERROR_FIELD_MAX_LENGTH
      ? `${error.slice(0, ERROR_FIELD_MAX_LENGTH)}…`
      : error;
  emit(level, {
    ...rest,
    error: truncatedError,
    event: 'credit_enrollment.failed',
    outcome: 'failed',
  });
}
