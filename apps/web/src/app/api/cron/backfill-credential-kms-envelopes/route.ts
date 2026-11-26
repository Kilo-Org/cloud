import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
  type ScheduledJobMetadata,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import {
  backfillCredentialKmsEnvelopes,
  type CredentialKmsBackfillStoreName,
  type CredentialKmsBackfillStoreSummary,
} from '@/lib/credential-kms-backfill';

export const maxDuration = 300;

/** Leaves the rest of `maxDuration` for the rows already in flight and the response. */
const WORK_BUDGET_MS = 180_000;

const STORE_NAMES: CredentialKmsBackfillStoreName[] = [
  'coding_plan_inventory',
  'openai_chatgpt_connections',
];

function failedCount(summary: CredentialKmsBackfillStoreSummary): number {
  return summary.failed.legacy_unreadable + summary.failed.kms + summary.failed.database;
}

/**
 * Failures a later run can fix. A static-key copy that does not decrypt is a standing fact:
 * readers already treat it as no credential, and retrying cannot change it, so it is reported
 * by count without failing every run.
 */
function retryableFailedCount(summary: CredentialKmsBackfillStoreSummary): number {
  return summary.failed.kms + summary.failed.database;
}

/** Every row left is one whose static-key copy does not decrypt and needs manual cleanup. */
function onlyUnreadableRemain(summary: CredentialKmsBackfillStoreSummary): boolean {
  return (
    summary.reachedEnd &&
    summary.remaining !== null &&
    summary.remaining > 0 &&
    summary.remaining === summary.failed.legacy_unreadable
  );
}

function storeMetadata(summary: CredentialKmsBackfillStoreSummary): ScheduledJobMetadata {
  const prefix = summary.store;
  return {
    [`${prefix}_scanned_count`]: summary.scanned,
    [`${prefix}_migrated_count`]: summary.migrated,
    [`${prefix}_skipped_concurrent_write_count`]: summary.skippedConcurrentWrite,
    [`${prefix}_failed_count`]: failedCount(summary),
    [`${prefix}_failed_legacy_unreadable_count`]: summary.failed.legacy_unreadable,
    [`${prefix}_failed_kms_count`]: summary.failed.kms,
    [`${prefix}_failed_database_count`]: summary.failed.database,
    // An unknown count is reported as unknown, never as zero.
    [`${prefix}_remaining_known`]: summary.remaining !== null,
    [`${prefix}_remaining_count`]: summary.remaining ?? undefined,
    [`${prefix}_completed`]: summary.remaining === 0,
    [`${prefix}_only_unreadable_remaining`]: onlyUnreadableRemain(summary),
    [`${prefix}_error`]: summary.errorName ?? undefined,
  };
}

/**
 * Creates the KMS envelope of existing Coding Plan inventory credentials and ChatGPT
 * connection payloads, a bounded pass per tick, until no row lacks a current one. Every
 * authorized tick logs one `scheduled_job.completed` event with each store's remaining
 * count; `backfill_completed: true` means both stores report zero remaining. KMS and
 * database failures mark the event failed with per-category counts, and a store whose count
 * could not be taken reports `<store>_remaining_known: false` instead of a count. Rows whose
 * static-key copy does not decrypt are counted on every tick without failing it, and
 * `<store>_only_unreadable_remaining: true` says nothing else is left in that store. Once complete, a tick is a
 * couple of counting queries, so the schedule can stay until the job is removed.
 */
export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.backfill_credential_kms_envelopes',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  let summaries: CredentialKmsBackfillStoreSummary[];
  try {
    summaries = await backfillCredentialKmsEnvelopes({ deadlineAt: Date.now() + WORK_BUDGET_MS });
  } catch (error) {
    const metadata: ScheduledJobMetadata = { backfill_completed: false };
    for (const store of STORE_NAMES) metadata[`${store}_remaining_known`] = false;
    emitScheduledJobEvent(
      buildScheduledJobFailureEvent({
        context: run,
        jobName: run.jobName,
        environment: run.environment,
        metadata,
        error,
      })
    );
    return NextResponse.json({ error: 'Credential KMS backfill failed' }, { status: 500 });
  }

  const completed = summaries.every(summary => summary.remaining === 0);
  const metadata: ScheduledJobMetadata = { backfill_completed: completed };
  for (const summary of summaries) Object.assign(metadata, storeMetadata(summary));

  const failed = summaries.some(
    summary =>
      retryableFailedCount(summary) > 0 || summary.remaining === null || summary.errorName !== null
  );
  const body = {
    completed,
    stores: summaries.map(summary => ({
      store: summary.store,
      scanned: summary.scanned,
      migrated: summary.migrated,
      skippedConcurrentWrite: summary.skippedConcurrentWrite,
      failed: summary.failed,
      remaining: summary.remaining,
    })),
  };

  if (failed) {
    emitScheduledJobEvent(
      buildScheduledJobFailureEvent({
        context: run,
        jobName: run.jobName,
        environment: run.environment,
        metadata,
        error: new Error('Credential KMS backfill did not finish cleanly'),
      })
    );
    return NextResponse.json(body, { status: 500 });
  }

  emitScheduledJobEvent(buildScheduledJobSuccessEvent(run, metadata));
  return NextResponse.json(body);
}
