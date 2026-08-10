export type ExportStatus = 'queued' | 'processing' | 'finalizing' | 'ready' | 'failed' | 'expired';
export type ExportEmailStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type WorkloadSeverity = 'ok' | 'degraded' | 'error';
export type ExecutionHealth =
  | 'waiting_dispatch'
  | 'processing'
  | 'interrupted_upload_cleanup'
  | 'lease_recovery_due'
  | 'lease_attempts_exhausted'
  | 'ready'
  | 'expiry_due'
  | 'expired'
  | 'failed'
  | 'inconsistent';
export type DispatchHealth = 'not_applicable' | 'missing' | 'published' | 'due' | 'backoff';
export type EmailHealth =
  | 'not_applicable'
  | 'window_closed'
  | 'pending'
  | 'sending'
  | 'retry_due'
  | 'sent'
  | 'failed'
  | 'stranded';

export type ExportHealthInput = {
  status: ExportStatus;
  attemptCount: number;
  leaseExpiresAt: string | null;
  hasWorkerLease: boolean;
  currentOutboxId: string | null;
  currentOutboxAvailableAt: string | null;
  currentOutboxSentAt: string | null;
  currentOutboxAttemptCount: number | null;
  hasMultipartUpload: boolean;
  hasLegacyGeneratorState: boolean;
  hasR2Object: boolean;
  expiresAt: string | null;
  emailStatus: ExportEmailStatus;
  emailAttemptCount: number;
  emailLeaseExpiresAt: string | null;
};

export type ExportHealth = {
  severity: WorkloadSeverity;
  execution: ExecutionHealth;
  dispatch: DispatchHealth;
  email: EmailHealth;
  reasons: string[];
  automaticWork: {
    workerClaim: boolean;
    reconcileToQueued: boolean;
    reconcileToFailed: boolean;
    dispatchCurrentOutbox: boolean;
    expireReadyObject: boolean;
    abortFailedMultipart: boolean;
    sendOrReclaimEmail: boolean;
    downloadAvailable: boolean;
  };
};

const ACTIVE_STATUSES: ExportStatus[] = ['queued', 'processing', 'finalizing'];

function before(value: string | null, now: number): boolean {
  return value !== null && new Date(value).getTime() < now;
}

function after(value: string | null, now: number): boolean {
  return value !== null && new Date(value).getTime() > now;
}

export function classifyExportHealth(input: ExportHealthInput, asOf: string): ExportHealth {
  const now = new Date(asOf).getTime();
  const active = ACTIVE_STATUSES.includes(input.status);
  const expiredLease = before(input.leaseExpiresAt, now);
  const unexpiredReady = input.status === 'ready' && after(input.expiresAt, now);
  const expiryDue = input.status === 'ready' && !after(input.expiresAt, now) && input.hasR2Object;
  const emailLeaseExpired = before(input.emailLeaseExpiresAt, now);
  const emailStranded =
    unexpiredReady &&
    input.emailAttemptCount >= 4 &&
    (input.emailStatus === 'pending' || (input.emailStatus === 'sending' && emailLeaseExpired));
  const emailRetryDue =
    unexpiredReady &&
    input.emailAttemptCount < 4 &&
    (input.emailStatus === 'pending' || (input.emailStatus === 'sending' && emailLeaseExpired));

  let execution: ExecutionHealth;
  if (input.status === 'failed') execution = 'failed';
  else if (input.status === 'expired') execution = 'expired';
  else if (expiryDue) execution = 'expiry_due';
  else if (input.status === 'ready') execution = 'ready';
  else if (
    (input.status === 'processing' || input.status === 'finalizing') &&
    expiredLease &&
    input.attemptCount >= 5
  )
    execution = 'lease_attempts_exhausted';
  else if ((input.status === 'processing' || input.status === 'finalizing') && expiredLease)
    execution = 'lease_recovery_due';
  else if (input.status === 'processing' && !input.hasWorkerLease) execution = 'inconsistent';
  else if (input.status === 'processing') execution = 'processing';
  else if (input.status === 'finalizing' && input.hasWorkerLease)
    execution = 'interrupted_upload_cleanup';
  else if (input.status === 'queued' && !input.hasWorkerLease) execution = 'waiting_dispatch';
  else execution = 'inconsistent';

  let dispatch: DispatchHealth;
  if (!active) dispatch = 'not_applicable';
  else if (!input.currentOutboxId) dispatch = 'missing';
  else if (input.currentOutboxSentAt) dispatch = 'published';
  else if (
    input.currentOutboxAvailableAt &&
    new Date(input.currentOutboxAvailableAt).getTime() <= now
  )
    dispatch = 'due';
  else dispatch = 'backoff';

  let email: EmailHealth;
  if (input.status !== 'ready') email = 'not_applicable';
  else if (!after(input.expiresAt, now) && input.emailStatus !== 'sent') email = 'window_closed';
  else if (input.emailStatus === 'sent') email = 'sent';
  else if (input.emailStatus === 'failed') email = 'failed';
  else if (emailStranded) email = 'stranded';
  else if (input.emailStatus === 'sending' && !emailLeaseExpired) email = 'sending';
  else if (emailRetryDue && input.emailAttemptCount > 0) email = 'retry_due';
  else email = 'pending';

  const reasons: string[] = [];
  if (input.status === 'failed') reasons.push('export_failed');
  if (execution === 'lease_attempts_exhausted') reasons.push('lease_attempts_exhausted');
  else if (execution === 'lease_recovery_due') reasons.push('lease_recovery_due');
  if (input.status === 'processing' && !input.hasWorkerLease)
    reasons.push('processing_without_lease');
  if (dispatch === 'missing') reasons.push('active_outbox_missing');
  if ((input.currentOutboxAttemptCount ?? 0) > 0 && dispatch !== 'not_applicable')
    reasons.push('outbox_dispatch_retry');
  if (input.status === 'failed' && input.hasMultipartUpload)
    reasons.push('failed_multipart_cleanup_due');
  if (input.hasLegacyGeneratorState) reasons.push('retired_generator_state');
  if (expiryDue) reasons.push('expiry_cleanup_due');
  if (email === 'failed') reasons.push('email_delivery_failed');
  if (email === 'stranded') reasons.push('email_retry_stranded');
  else if (email === 'retry_due') reasons.push('email_retry_due');
  if (active && !input.hasWorkerLease && input.status === 'finalizing')
    reasons.push('finalizing_without_lease');
  if (input.status === 'queued' && input.hasWorkerLease) reasons.push('queued_with_held_lease');
  if (!active && input.hasWorkerLease) reasons.push('terminal_with_worker_lease');

  const hasError = reasons.some(reason =>
    [
      'export_failed',
      'lease_attempts_exhausted',
      'processing_without_lease',
      'active_outbox_missing',
      'email_retry_stranded',
      'finalizing_without_lease',
      'queued_with_held_lease',
      'terminal_with_worker_lease',
      'retired_generator_state',
    ].includes(reason)
  );
  const severity: WorkloadSeverity = hasError ? 'error' : reasons.length > 0 ? 'degraded' : 'ok';

  return {
    severity,
    execution,
    dispatch,
    email,
    reasons,
    automaticWork: {
      workerClaim: active && (!input.leaseExpiresAt || expiredLease),
      reconcileToQueued:
        (input.status === 'processing' || input.status === 'finalizing') &&
        expiredLease &&
        input.attemptCount < 5,
      reconcileToFailed:
        (input.status === 'processing' || input.status === 'finalizing') &&
        expiredLease &&
        input.attemptCount >= 5,
      dispatchCurrentOutbox:
        input.currentOutboxSentAt === null &&
        input.currentOutboxAvailableAt !== null &&
        new Date(input.currentOutboxAvailableAt).getTime() <= now,
      expireReadyObject: expiryDue,
      abortFailedMultipart: input.status === 'failed' && input.hasMultipartUpload,
      sendOrReclaimEmail: emailRetryDue,
      downloadAvailable: unexpiredReady && input.hasR2Object,
    },
  };
}
