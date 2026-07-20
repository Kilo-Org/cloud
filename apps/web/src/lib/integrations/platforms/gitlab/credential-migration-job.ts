import 'server-only';

import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { getGitLabCredentialEncryptionPublicKeyInfo } from './credential-encryption';
import {
  hasBlockingGitLabCredentialAuditIssues,
  type GitLabCredentialAuditCounts,
} from './credential-migration-audit';
import {
  GitLabCredentialMigrationLeaseLostError,
  processGitLabCredentialMigrationBatch,
  type GitLabCredentialMigrationBatch,
} from './credential-migration';
import {
  checkpointGitLabCredentialMigrationJob,
  completeGitLabCredentialMigrationJob,
  failGitLabCredentialMigrationJob,
  incrementGitLabCredentialMigrationJobRetry,
  hasGitLabCredentialMigrationJobLease,
  transitionGitLabCredentialMigrationJobPhase,
  type GitLabCredentialMigrationJobRecord,
  type GitLabCredentialPrivateAuditCounts,
  type LeasedGitLabCredentialMigrationJobRecord,
} from './credential-migration-job-repository';
import { requestGitLabCredentialPrivateAudit } from './credential-private-audit-client';

const MAX_PRIVATE_AUDIT_RETRIES = 3;

export type GitLabCredentialMigrationJobStepResult =
  | {
      kind: 'advanced';
      job: GitLabCredentialMigrationJobRecord;
      batch?: GitLabCredentialMigrationBatch;
    }
  | { kind: 'completed' }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'retryable'; errorCode: string }
  | { kind: 'cancelled_or_lost_lease' };

function addPublicCounts(
  current: GitLabCredentialAuditCounts,
  delta: GitLabCredentialAuditCounts
): GitLabCredentialAuditCounts {
  const next = { ...current };
  for (const key of Object.keys(next) as Array<keyof GitLabCredentialAuditCounts>) {
    next[key] += delta[key];
  }
  return next;
}

function addPrivateCounts(
  current: GitLabCredentialPrivateAuditCounts,
  delta: GitLabCredentialPrivateAuditCounts
): GitLabCredentialPrivateAuditCounts {
  const next = { ...current };
  for (const key of Object.keys(next) as Array<keyof GitLabCredentialPrivateAuditCounts>) {
    next[key] += delta[key];
  }
  return next;
}

function hasPrivateAuditFailures(counts: GitLabCredentialPrivateAuditCounts): boolean {
  return (
    counts.credentials !== counts.passedCredentials ||
    counts.profileFailures > 0 ||
    counts.configurationFailures > 0 ||
    counts.parseFailures > 0 ||
    counts.unknownKeyFailures > 0 ||
    counts.decryptOrAadFailures > 0
  );
}

function finalPublicAuditPasses(counts: GitLabCredentialAuditCounts): boolean {
  return (
    !hasBlockingGitLabCredentialAuditIssues(counts) &&
    counts.legacySecretFields === 0 &&
    counts.legacyTokenBearingIntegrations === 0
  );
}

async function requesterIsActiveAdmin(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.id, userId),
        eq(kilocode_users.is_admin, true),
        isNull(kilocode_users.blocked_reason)
      )
    )
    .limit(1);
  return Boolean(user);
}

async function fail(
  job: LeasedGitLabCredentialMigrationJobRecord,
  errorCode: string
): Promise<GitLabCredentialMigrationJobStepResult> {
  const updated = await failGitLabCredentialMigrationJob(job.id, job.lease_token, errorCode);
  return updated ? { kind: 'failed', errorCode } : { kind: 'cancelled_or_lost_lease' };
}

async function checkpointPublicBatch(
  job: LeasedGitLabCredentialMigrationJobRecord,
  batch: GitLabCredentialMigrationBatch
): Promise<LeasedGitLabCredentialMigrationJobRecord | null> {
  return checkpointGitLabCredentialMigrationJob({
    jobId: job.id,
    leaseToken: job.lease_token,
    cursor: batch.nextCursor,
    scannedIntegrations: job.scanned_integrations + batch.scannedIntegrations,
    mutatedIntegrations: job.mutated_integrations + batch.mutatedIntegrations,
    publicAuditCounts: addPublicCounts(job.public_audit_counts, batch.counts),
    privateAuditCounts: job.private_audit_counts,
    issueIntegrationIds: [...job.issue_integration_ids, ...batch.issueIntegrationIds],
    privateAuditKeyId: job.private_audit_key_id,
    privateAuditPublicKeySha256: job.private_audit_public_key_sha256,
  });
}

async function advancePublicPhase(
  job: LeasedGitLabCredentialMigrationJobRecord,
  mode: 'audit' | 'backfill' | 'scrub'
): Promise<GitLabCredentialMigrationJobStepResult> {
  let batch: GitLabCredentialMigrationBatch;
  try {
    batch = await processGitLabCredentialMigrationBatch({
      mode,
      afterIntegrationId: job.cursor,
      batchSize: 100,
      apply: mode !== 'audit',
      assertLease: () => hasGitLabCredentialMigrationJobLease(job.id, job.lease_token),
    });
  } catch (error) {
    if (error instanceof GitLabCredentialMigrationLeaseLostError) {
      return { kind: 'cancelled_or_lost_lease' };
    }
    return fail(job, mode === 'scrub' ? 'scrub_validation_failed' : 'migration_batch_failed');
  }
  const checkpointed = await checkpointPublicBatch(job, batch);
  if (!checkpointed) return { kind: 'cancelled_or_lost_lease' };
  if (!batch.complete) return { kind: 'advanced', job: checkpointed, batch };

  const publicCounts = checkpointed.public_audit_counts;
  if (job.phase === 'public_audit') {
    if (hasBlockingGitLabCredentialAuditIssues(publicCounts))
      return fail(checkpointed, 'public_audit_failed');
    if (job.requested_mode === 'audit') {
      return (await completeGitLabCredentialMigrationJob(job.id, job.lease_token))
        ? { kind: 'completed' }
        : { kind: 'cancelled_or_lost_lease' };
    }
    const transitioned = await transitionGitLabCredentialMigrationJobPhase({
      jobId: job.id,
      leaseToken: job.lease_token,
      phase: 'scrub',
      clearPublicAudit: true,
    });
    return transitioned
      ? { kind: 'advanced', job: transitioned, batch }
      : { kind: 'cancelled_or_lost_lease' };
  }
  if (job.phase === 'backfill') {
    const transitioned = await transitionGitLabCredentialMigrationJobPhase({
      jobId: job.id,
      leaseToken: job.lease_token,
      phase: 'final_public_audit',
      clearPublicAudit: true,
    });
    return transitioned
      ? { kind: 'advanced', job: transitioned, batch }
      : { kind: 'cancelled_or_lost_lease' };
  }
  if (job.phase === 'scrub') {
    const transitioned = await transitionGitLabCredentialMigrationJobPhase({
      jobId: job.id,
      leaseToken: job.lease_token,
      phase: 'final_public_audit',
      clearPublicAudit: true,
    });
    return transitioned
      ? { kind: 'advanced', job: transitioned, batch }
      : { kind: 'cancelled_or_lost_lease' };
  }
  if (job.phase !== 'final_public_audit') return fail(checkpointed, 'invalid_phase');
  if (hasBlockingGitLabCredentialAuditIssues(publicCounts))
    return fail(checkpointed, 'final_public_audit_failed');
  if (job.requested_mode === 'backfill') {
    return (await completeGitLabCredentialMigrationJob(job.id, job.lease_token))
      ? { kind: 'completed' }
      : { kind: 'cancelled_or_lost_lease' };
  }
  if (!finalPublicAuditPasses(publicCounts))
    return fail(checkpointed, 'legacy_plaintext_remaining');
  const transitioned = await transitionGitLabCredentialMigrationJobPhase({
    jobId: job.id,
    leaseToken: job.lease_token,
    phase: 'final_private_audit',
    clearPrivateAudit: true,
  });
  return transitioned
    ? { kind: 'advanced', job: transitioned, batch }
    : { kind: 'cancelled_or_lost_lease' };
}

async function advancePrivateAudit(
  job: LeasedGitLabCredentialMigrationJobRecord
): Promise<GitLabCredentialMigrationJobStepResult> {
  const response = await requestGitLabCredentialPrivateAudit({
    requestedByUserId: job.requested_by_user_id,
    cursor: job.cursor,
  });
  if (response.kind === 'terminal_error') return fail(job, response.errorCode);
  if (response.kind === 'retryable_error') {
    const retried = await incrementGitLabCredentialMigrationJobRetry(job.id, job.lease_token);
    if (!retried) return { kind: 'cancelled_or_lost_lease' };
    if (retried.retry_count > MAX_PRIVATE_AUDIT_RETRIES) return fail(retried, response.errorCode);
    return { kind: 'retryable', errorCode: response.errorCode };
  }
  const { audit } = response;
  if (!audit.activeKey || hasPrivateAuditFailures(audit.counts)) {
    return fail(job, audit.activeKey ? 'private_audit_failed' : 'private_key_unavailable');
  }
  if (
    (job.private_audit_key_id && job.private_audit_key_id !== audit.activeKey.keyId) ||
    (job.private_audit_public_key_sha256 &&
      job.private_audit_public_key_sha256 !== audit.activeKey.publicKeySha256)
  ) {
    return fail(job, 'private_key_changed');
  }
  let webKey: { keyId: string; publicKeySha256: string };
  try {
    webKey = getGitLabCredentialEncryptionPublicKeyInfo();
  } catch {
    return fail(job, 'public_key_unavailable');
  }
  if (
    webKey.keyId !== audit.activeKey.keyId ||
    webKey.publicKeySha256 !== audit.activeKey.publicKeySha256
  ) {
    return fail(job, 'private_public_key_mismatch');
  }
  const checkpointed = await checkpointGitLabCredentialMigrationJob({
    jobId: job.id,
    leaseToken: job.lease_token,
    cursor: audit.nextCursor,
    scannedIntegrations: job.scanned_integrations,
    mutatedIntegrations: job.mutated_integrations,
    publicAuditCounts: job.public_audit_counts,
    privateAuditCounts: addPrivateCounts(job.private_audit_counts, audit.counts),
    issueIntegrationIds: job.issue_integration_ids,
    privateAuditKeyId: audit.activeKey.keyId,
    privateAuditPublicKeySha256: audit.activeKey.publicKeySha256,
  });
  if (!checkpointed) return { kind: 'cancelled_or_lost_lease' };
  if (audit.nextCursor) return { kind: 'advanced', job: checkpointed };
  if (job.phase === 'private_audit') {
    const transitioned = await transitionGitLabCredentialMigrationJobPhase({
      jobId: job.id,
      leaseToken: job.lease_token,
      phase: 'public_audit',
      clearPublicAudit: true,
    });
    return transitioned
      ? { kind: 'advanced', job: transitioned }
      : { kind: 'cancelled_or_lost_lease' };
  }
  return (await completeGitLabCredentialMigrationJob(job.id, job.lease_token))
    ? { kind: 'completed' }
    : { kind: 'cancelled_or_lost_lease' };
}

export async function advanceGitLabCredentialMigrationJob(
  job: GitLabCredentialMigrationJobRecord
): Promise<GitLabCredentialMigrationJobStepResult> {
  if (!job.lease_token || job.status !== 'running') return { kind: 'cancelled_or_lost_lease' };
  const leasedJob: LeasedGitLabCredentialMigrationJobRecord = {
    ...job,
    lease_token: job.lease_token,
  };
  if (!(await requesterIsActiveAdmin(leasedJob.requested_by_user_id)))
    return fail(leasedJob, 'requester_not_admin');
  if (leasedJob.phase === 'private_audit' || leasedJob.phase === 'final_private_audit') {
    return advancePrivateAudit(leasedJob);
  }
  if (leasedJob.phase === 'backfill' || leasedJob.phase === 'scrub')
    return advancePublicPhase(leasedJob, leasedJob.phase);
  return advancePublicPhase(leasedJob, 'audit');
}
