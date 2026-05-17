export const TERMINAL_RENEWAL_FAILURE_STATUSES = {
  unresolved: 'unresolved',
  resolved: 'resolved',
  waived: 'waived',
  superseded: 'superseded',
} as const;

export type TerminalRenewalFailureStatus =
  (typeof TERMINAL_RENEWAL_FAILURE_STATUSES)[keyof typeof TERMINAL_RENEWAL_FAILURE_STATUSES];

export const TERMINAL_RENEWAL_SYSTEM_FAILURES = {
  creditBalanceReadFailed: 'credit_balance_read_failed',
  renewalTransactionFailed: 'renewal_transaction_failed',
  autoTopUpMarkerWriteFailed: 'auto_top_up_marker_write_failed',
  workerTimeout: 'worker_timeout',
  poisonPayload: 'poison_payload',
  queueDeliveryExhausted: 'queue_delivery_exhausted',
} as const;

export type TerminalRenewalSystemFailure =
  (typeof TERMINAL_RENEWAL_SYSTEM_FAILURES)[keyof typeof TERMINAL_RENEWAL_SYSTEM_FAILURES];

export const EXPECTED_CREDIT_RENEWAL_OUTCOMES = {
  renewed: 'renewed',
  canceledAtPeriodEnd: 'canceled_at_period_end',
  insufficientCreditsPastDue: 'insufficient_credits_past_due',
  autoTopUpDeferred: 'auto_top_up_deferred',
  duplicateIdempotencyReconciled: 'duplicate_idempotency_reconciled',
  staleOrIneligibleSkipped: 'stale_or_ineligible_skipped',
} as const;

export type ExpectedCreditRenewalOutcome =
  (typeof EXPECTED_CREDIT_RENEWAL_OUTCOMES)[keyof typeof EXPECTED_CREDIT_RENEWAL_OUTCOMES];

export type CreditRenewalFailureQualification =
  | TerminalRenewalSystemFailure
  | ExpectedCreditRenewalOutcome;

export type TerminalRenewalFailureKey = {
  subscriptionId: string;
  renewalBoundary: string;
};

export type TerminalRenewalFailureOperatorMetadata = {
  actor: {
    type: 'operator';
    id: string;
  };
  timestamp: string;
  reason: string;
  retryContext?: {
    requestedAttempt?: number;
    queueMessageId?: string;
  };
};

export type TerminalRenewalFailureTransition = {
  from: TerminalRenewalFailureStatus | null;
  to: TerminalRenewalFailureStatus;
  reason:
    | 'automatic_retry_exhausted'
    | 'dead_lettered'
    | 'operator_retry_succeeded'
    | 'operator_marked_resolved'
    | 'operator_waived'
    | 'subscription_boundary_advanced';
  attempts?: number;
  failureKind?: 'system_failure' | 'expected_business_outcome';
  operatorMetadata?: TerminalRenewalFailureOperatorMetadata;
};

export type TerminalRenewalFailureTransitionResult = { ok: true } | { ok: false; error: string };

export function buildTerminalRenewalFailureKey(
  key: TerminalRenewalFailureKey
): TerminalRenewalFailureKey {
  return key;
}

export function isTerminalRenewalFailureEnforcementProtected(
  status: TerminalRenewalFailureStatus
): boolean {
  return status === TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved;
}

export function qualifiesForTerminalRenewalFailure(
  outcome: CreditRenewalFailureQualification
): boolean {
  return (
    outcome === TERMINAL_RENEWAL_SYSTEM_FAILURES.creditBalanceReadFailed ||
    outcome === TERMINAL_RENEWAL_SYSTEM_FAILURES.renewalTransactionFailed ||
    outcome === TERMINAL_RENEWAL_SYSTEM_FAILURES.autoTopUpMarkerWriteFailed ||
    outcome === TERMINAL_RENEWAL_SYSTEM_FAILURES.workerTimeout ||
    outcome === TERMINAL_RENEWAL_SYSTEM_FAILURES.poisonPayload ||
    outcome === TERMINAL_RENEWAL_SYSTEM_FAILURES.queueDeliveryExhausted
  );
}

export function validateTerminalRenewalFailureTransition(
  transition: TerminalRenewalFailureTransition
): TerminalRenewalFailureTransitionResult {
  if (isCreateUnresolvedTransition(transition)) {
    return { ok: true };
  }

  if (isOperatorResolvedTransition(transition)) {
    return { ok: true };
  }

  if (isOperatorWaivedTransition(transition)) {
    return { ok: true };
  }

  if (isSupersededTransition(transition)) {
    return { ok: true };
  }

  return { ok: false, error: 'invalid_terminal_renewal_failure_transition' };
}

function isCreateUnresolvedTransition(transition: TerminalRenewalFailureTransition): boolean {
  return (
    transition.from === null &&
    transition.to === TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved &&
    (transition.reason === 'automatic_retry_exhausted' || transition.reason === 'dead_lettered') &&
    transition.attempts !== undefined &&
    transition.attempts >= 3 &&
    transition.failureKind === 'system_failure'
  );
}

function isOperatorResolvedTransition(transition: TerminalRenewalFailureTransition): boolean {
  return (
    transition.from === TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved &&
    transition.to === TERMINAL_RENEWAL_FAILURE_STATUSES.resolved &&
    (transition.reason === 'operator_retry_succeeded' ||
      transition.reason === 'operator_marked_resolved') &&
    hasOperatorMetadata(transition.operatorMetadata)
  );
}

function isOperatorWaivedTransition(transition: TerminalRenewalFailureTransition): boolean {
  return (
    transition.from === TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved &&
    transition.to === TERMINAL_RENEWAL_FAILURE_STATUSES.waived &&
    transition.reason === 'operator_waived' &&
    hasOperatorMetadata(transition.operatorMetadata)
  );
}

function isSupersededTransition(transition: TerminalRenewalFailureTransition): boolean {
  return (
    transition.from === TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved &&
    transition.to === TERMINAL_RENEWAL_FAILURE_STATUSES.superseded &&
    transition.reason === 'subscription_boundary_advanced'
  );
}

function hasOperatorMetadata(
  metadata: TerminalRenewalFailureOperatorMetadata | undefined
): metadata is TerminalRenewalFailureOperatorMetadata {
  return (
    metadata !== undefined &&
    metadata.actor.type === 'operator' &&
    metadata.actor.id.length > 0 &&
    metadata.timestamp.length > 0 &&
    metadata.reason.length > 0
  );
}
