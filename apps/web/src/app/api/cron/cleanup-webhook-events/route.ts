import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { webhook_events } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  dropExpiredWebhookEventPartitions,
  isTransientPartitionError,
  provisionWebhookEventPartitions,
  pruneExpiredWebhookEventSignatures,
} from '@/lib/integrations/db/webhook-event-partitions';

const RETENTION_DAYS = 60;
const BATCH_SIZE = 2_500;
const MAX_BATCHES_PER_RUN = 2;

export const maxDuration = 300;

type BatchResult = {
  deletedCount: number;
  hasMore: boolean;
};

/**
 * Retention for the pre-partitioning `webhook_events` table, which only shrinks
 * now that writes go to `webhook_events_v2`. Remove once that table is dropped.
 */
async function deleteExpiredBatch(cutoffDate: string): Promise<BatchResult> {
  const expiredRows = await db
    .select({ id: webhook_events.id })
    .from(webhook_events)
    .where(lt(webhook_events.created_at, cutoffDate))
    .orderBy(asc(webhook_events.created_at))
    .limit(BATCH_SIZE + 1);

  const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
  const result =
    batchIds.length > 0
      ? await db.delete(webhook_events).where(inArray(webhook_events.id, batchIds))
      : null;

  return { deletedCount: result?.rowCount ?? 0, hasMore: expiredRows.length > BATCH_SIZE };
}

/**
 * `blocking` issues need an operator. A lock or statement timeout, or a detach
 * still pending from another run, clears on a later run days before any insert
 * could need the partition, so it is only a warning.
 */
type MaintenanceIssue = { step: string; name: string; error: unknown; blocking: boolean };

function describeIssue({ step, name, error }: MaintenanceIssue): string {
  return `${step} ${name}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Keeps `webhook_events_v2` writable and within retention. Never throws: each
 * step is isolated so a failure in one, or in the legacy cleanup that runs
 * after, cannot stop the coming days' partitions from being created.
 */
async function maintainPartitions() {
  const issues: MaintenanceIssue[] = [];
  const isolate = async <T>(step: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      issues.push({ step, name: 'all', error, blocking: !isTransientPartitionError(error) });
      return null;
    }
  };

  const provisioning = await isolate('provision', () => provisionWebhookEventPartitions(db));
  const retention = await isolate('drop', () => dropExpiredWebhookEventPartitions(db));
  const signatures = await isolate('prune', () => pruneExpiredWebhookEventSignatures(db));

  for (const { name, error } of provisioning?.errors ?? []) {
    issues.push({ step: 'provision', name, error, blocking: !isTransientPartitionError(error) });
  }
  for (const { name, error } of retention?.errors ?? []) {
    issues.push({ step: 'drop', name, error, blocking: !isTransientPartitionError(error) });
  }
  // Inserts for today or tomorrow fail without these, however transient the cause.
  for (const name of provisioning?.missingSoon ?? []) {
    issues.push({
      step: 'provision',
      name,
      error: new Error('partition for today or tomorrow is missing'),
      blocking: true,
    });
  }

  return { provisioning, retention, signatures, issues };
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_webhook_events',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  // First, so nothing below can keep the partitioned table from staying writable.
  const maintenance = await maintainPartitions();
  const blockingIssues = maintenance.issues.filter(issue => issue.blocking);
  for (const issue of maintenance.issues) {
    if (issue.blocking) {
      captureException(issue.error, {
        tags: { source: 'cleanup-webhook-events', step: issue.step, partition: issue.name },
      });
    } else {
      console.warn(
        '[cleanup-webhook-events] transient partition maintenance issue',
        describeIssue(issue)
      );
    }
  }

  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();

    let deletedCount = 0;
    let hasMore = false;
    let batchesRun = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const result = await deleteExpiredBatch(cutoffDate);
      deletedCount += result.deletedCount;
      hasMore = result.hasMore;
      batchesRun++;

      if (!hasMore || result.deletedCount === 0) {
        break;
      }
    }

    const summary = {
      deletedCount,
      batchSize: BATCH_SIZE,
      batchesRun,
      hasMore,
      cutoffDate,
      partitionsCreated: maintenance.provisioning?.created ?? [],
      partitionsDropped: maintenance.retention?.dropped ?? [],
      partitionsFinalized: maintenance.retention?.finalized ?? [],
      partitionErrors: blockingIssues.map(describeIssue),
      partitionWarnings: maintenance.issues.filter(issue => !issue.blocking).map(describeIssue),
      signaturesDeleted: maintenance.signatures?.deletedCount ?? 0,
      signaturesHasMore: maintenance.signatures?.hasMore ?? false,
      timestamp: new Date().toISOString(),
    };

    if (blockingIssues.length > 0) {
      emitScheduledJobEvent(
        buildScheduledJobFailureEvent(
          run,
          new Error(
            `webhook_events_v2 partition maintenance failed: ${summary.partitionErrors.join('; ')}`
          )
        )
      );
      return NextResponse.json(summary, { status: 500 });
    }

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_webhook_events_count: deletedCount,
        deleted_count: deletedCount,
        batch_size: BATCH_SIZE,
        batches_run: batchesRun,
        has_more: hasMore,
        created_partition_count: summary.partitionsCreated.length,
        dropped_partition_count: summary.partitionsDropped.length,
        partition_warning_count: summary.partitionWarnings.length,
        deleted_signature_count: summary.signaturesDeleted,
        signatures_has_more: summary.signaturesHasMore,
      })
    );

    return NextResponse.json(summary);
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
