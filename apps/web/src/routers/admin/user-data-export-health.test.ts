import { classifyExportHealth, type ExportHealthInput } from './user-data-export-health';

const AS_OF = '2026-08-09T19:00:00.000Z';

function input(overrides: Partial<ExportHealthInput> = {}): ExportHealthInput {
  return {
    status: 'queued',
    attemptCount: 0,
    leaseExpiresAt: null,
    hasWorkerLease: false,
    currentOutboxId: 'outbox-id',
    currentOutboxAvailableAt: '2026-08-09T18:59:00.000Z',
    currentOutboxSentAt: '2026-08-09T18:59:01.000Z',
    currentOutboxAttemptCount: 0,
    hasMultipartUpload: false,
    hasLegacyGeneratorState: false,
    hasR2Object: false,
    expiresAt: null,
    emailStatus: 'pending',
    emailAttemptCount: 0,
    emailLeaseExpiresAt: null,
    ...overrides,
  };
}

describe('classifyExportHealth', () => {
  it('classifies a published queued export as healthy and claimable', () => {
    const health = classifyExportHealth(input(), AS_OF);

    expect(health).toMatchObject({
      severity: 'ok',
      execution: 'waiting_dispatch',
      dispatch: 'published',
      email: 'not_applicable',
      reasons: [],
      automaticWork: { workerClaim: true },
    });
  });

  it('classifies stale processing leases by retry exhaustion threshold', () => {
    const retryable = classifyExportHealth(
      input({
        status: 'processing',
        attemptCount: 4,
        hasWorkerLease: true,
        leaseExpiresAt: '2026-08-09T18:45:00.000Z',
      }),
      AS_OF
    );
    const exhausted = classifyExportHealth(
      input({
        status: 'processing',
        attemptCount: 5,
        hasWorkerLease: true,
        leaseExpiresAt: '2026-08-09T18:45:00.000Z',
      }),
      AS_OF
    );

    expect(retryable).toMatchObject({
      severity: 'degraded',
      execution: 'lease_recovery_due',
      automaticWork: { reconcileToQueued: true, reconcileToFailed: false },
    });
    expect(exhausted).toMatchObject({
      severity: 'error',
      execution: 'lease_attempts_exhausted',
      automaticWork: { reconcileToQueued: false, reconcileToFailed: true },
    });
  });

  it('reports missing control-plane state and invalid lease shapes as errors', () => {
    const health = classifyExportHealth(
      input({
        status: 'finalizing',
        currentOutboxId: null,
        currentOutboxAvailableAt: null,
        currentOutboxSentAt: null,
      }),
      AS_OF
    );

    expect(health.severity).toBe('error');
    expect(health.dispatch).toBe('missing');
    expect(health.reasons).toEqual(
      expect.arrayContaining(['active_outbox_missing', 'finalizing_without_lease'])
    );
  });

  it('classifies processing without a worker lease as an error', () => {
    const health = classifyExportHealth(
      input({
        status: 'processing',
        hasWorkerLease: false,
        leaseExpiresAt: null,
      }),
      AS_OF
    );

    expect(health).toMatchObject({
      severity: 'error',
      execution: 'inconsistent',
      dispatch: 'published',
      reasons: expect.arrayContaining(['processing_without_lease']),
    });
  });

  it('distinguishes retryable and stranded email delivery', () => {
    const retryable = classifyExportHealth(
      input({
        status: 'ready',
        hasR2Object: true,
        expiresAt: '2026-08-16T19:00:00.000Z',
        emailStatus: 'sending',
        emailAttemptCount: 2,
        emailLeaseExpiresAt: '2026-08-09T18:50:00.000Z',
      }),
      AS_OF
    );
    const stranded = classifyExportHealth(
      input({
        status: 'ready',
        hasR2Object: true,
        expiresAt: '2026-08-16T19:00:00.000Z',
        emailStatus: 'sending',
        emailAttemptCount: 4,
        emailLeaseExpiresAt: '2026-08-09T18:50:00.000Z',
      }),
      AS_OF
    );

    expect(retryable).toMatchObject({
      severity: 'degraded',
      email: 'retry_due',
      automaticWork: { sendOrReclaimEmail: true },
    });
    expect(stranded).toMatchObject({
      severity: 'error',
      email: 'stranded',
      automaticWork: { sendOrReclaimEmail: false },
    });
  });

  it('marks retained ready objects for automatic expiry cleanup', () => {
    const health = classifyExportHealth(
      input({
        status: 'ready',
        hasR2Object: true,
        expiresAt: '2026-08-09T18:00:00.000Z',
        emailStatus: 'sent',
      }),
      AS_OF
    );

    expect(health).toMatchObject({
      severity: 'degraded',
      execution: 'expiry_due',
      automaticWork: { expireReadyObject: true, downloadAvailable: false },
    });
  });
});
