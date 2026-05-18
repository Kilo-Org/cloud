import { describe, expect, it } from 'vitest';

import {
  EXPECTED_CREDIT_RENEWAL_OUTCOMES,
  TERMINAL_RENEWAL_FAILURE_STATUSES,
  TERMINAL_RENEWAL_SYSTEM_FAILURES,
  buildTerminalRenewalFailureKey,
  isTerminalRenewalFailureEnforcementProtected,
  qualifiesForTerminalRenewalFailure,
  validateTerminalRenewalFailureTransition,
} from './terminal-renewal-failure.js';

describe('credit-renewal terminal failure model', () => {
  it('creates an unresolved terminal failure for a subscription renewal boundary after automatic retry exhaustion', () => {
    const boundary = '2026-05-01T00:00:00.000Z';

    expect(
      buildTerminalRenewalFailureKey({
        subscriptionId: 'sub_123',
        renewalBoundary: boundary,
      })
    ).toEqual({
      subscriptionId: 'sub_123',
      renewalBoundary: boundary,
    });

    expect(
      validateTerminalRenewalFailureTransition({
        from: null,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        reason: 'automatic_retry_exhausted',
        attempts: 3,
        failureKind: 'system_failure',
      })
    ).toEqual({ ok: true });
  });

  it('defines stable terminal failure states and enforcement protection semantics', () => {
    expect(TERMINAL_RENEWAL_FAILURE_STATUSES).toEqual({
      unresolved: 'unresolved',
      resolved: 'resolved',
      waived: 'waived',
      superseded: 'superseded',
    });

    expect(
      isTerminalRenewalFailureEnforcementProtected(TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved)
    ).toBe(true);
    expect(
      isTerminalRenewalFailureEnforcementProtected(TERMINAL_RENEWAL_FAILURE_STATUSES.resolved)
    ).toBe(false);
    expect(
      isTerminalRenewalFailureEnforcementProtected(TERMINAL_RENEWAL_FAILURE_STATUSES.waived)
    ).toBe(false);
    expect(
      isTerminalRenewalFailureEnforcementProtected(TERMINAL_RENEWAL_FAILURE_STATUSES.superseded)
    ).toBe(false);
  });

  it('allows only the defined lifecycle transitions into and out of unresolved failure', () => {
    const operatorMetadata = {
      actor: { type: 'operator', id: 'ops-user-1' },
      timestamp: '2026-05-02T10:00:00.000Z',
      reason: 'retry succeeded after queue recovery',
      retryContext: { requestedAttempt: 4, queueMessageId: 'msg_123' },
    } as const;

    expect(
      validateTerminalRenewalFailureTransition({
        from: null,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        reason: 'dead_lettered',
        attempts: 3,
        failureKind: 'system_failure',
      })
    ).toEqual({ ok: true });
    expect(
      validateTerminalRenewalFailureTransition({
        from: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.resolved,
        reason: 'operator_retry_succeeded',
        operatorMetadata,
      })
    ).toEqual({ ok: true });
    expect(
      validateTerminalRenewalFailureTransition({
        from: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.waived,
        reason: 'operator_waived',
        operatorMetadata,
      })
    ).toEqual({ ok: true });
    expect(
      validateTerminalRenewalFailureTransition({
        from: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.superseded,
        reason: 'subscription_boundary_advanced',
      })
    ).toEqual({ ok: true });
  });

  it('distinguishes terminal system failures from expected credit-renewal outcomes', () => {
    expect(TERMINAL_RENEWAL_SYSTEM_FAILURES).toEqual({
      creditBalanceReadFailed: 'credit_balance_read_failed',
      renewalTransactionFailed: 'renewal_transaction_failed',
      autoTopUpMarkerWriteFailed: 'auto_top_up_marker_write_failed',
      workerTimeout: 'worker_timeout',
      poisonPayload: 'poison_payload',
      queueDeliveryExhausted: 'queue_delivery_exhausted',
    });
    expect(EXPECTED_CREDIT_RENEWAL_OUTCOMES).toEqual({
      renewed: 'renewed',
      canceledAtPeriodEnd: 'canceled_at_period_end',
      insufficientCreditsPastDue: 'insufficient_credits_past_due',
      autoTopUpDeferred: 'auto_top_up_deferred',
      duplicateIdempotencyReconciled: 'duplicate_idempotency_reconciled',
      staleOrIneligibleSkipped: 'stale_or_ineligible_skipped',
    });

    expect(
      qualifiesForTerminalRenewalFailure(TERMINAL_RENEWAL_SYSTEM_FAILURES.renewalTransactionFailed)
    ).toBe(true);
    expect(
      qualifiesForTerminalRenewalFailure(
        EXPECTED_CREDIT_RENEWAL_OUTCOMES.insufficientCreditsPastDue
      )
    ).toBe(false);
    expect(
      qualifiesForTerminalRenewalFailure(EXPECTED_CREDIT_RENEWAL_OUTCOMES.staleOrIneligibleSkipped)
    ).toBe(false);
  });

  it('rejects invalid repository transitions before persistence', () => {
    const invalid = { ok: false, error: 'invalid_terminal_renewal_failure_transition' };

    expect(
      validateTerminalRenewalFailureTransition({
        from: null,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        reason: 'automatic_retry_exhausted',
        attempts: 2,
        failureKind: 'system_failure',
      })
    ).toEqual(invalid);
    expect(
      validateTerminalRenewalFailureTransition({
        from: null,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        reason: 'automatic_retry_exhausted',
        attempts: 3,
        failureKind: 'expected_business_outcome',
      })
    ).toEqual(invalid);
    expect(
      validateTerminalRenewalFailureTransition({
        from: TERMINAL_RENEWAL_FAILURE_STATUSES.unresolved,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.waived,
        reason: 'operator_waived',
      })
    ).toEqual(invalid);
    expect(
      validateTerminalRenewalFailureTransition({
        from: TERMINAL_RENEWAL_FAILURE_STATUSES.resolved,
        to: TERMINAL_RENEWAL_FAILURE_STATUSES.waived,
        reason: 'operator_waived',
        operatorMetadata: {
          actor: { type: 'operator', id: 'ops-user-1' },
          timestamp: '2026-05-02T10:00:00.000Z',
          reason: 'late waiver request',
        },
      })
    ).toEqual(invalid);
  });
});
