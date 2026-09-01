import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { EnkryptFailureCategorySchema, EnkryptSyncCountsSchema } from '@kilocode/db/schema-types';
import * as z from 'zod';
import { CRON_SECRET } from '@/lib/config.server';
import { EnkryptSyncError } from '@/lib/model-stats/enkrypt-errors';
import { getEnkryptSyncHealth, recordEnkryptSyncAlert } from '@/lib/model-stats/enkrypt-status';
import type { EnkryptSyncHealth } from '@/lib/model-stats/enkrypt-status';
import {
  AdminSlackNotificationError,
  sendAdminSlackNotification,
} from '@/lib/slack/admin-notifications';

export const maxDuration = 60;

const AlertReasonSchema = z.union([
  EnkryptFailureCategorySchema,
  z.enum(['stale', 'never_succeeded', 'monitor_error']),
]);
const HealthSchema = z.object({
  status: z.enum(['disabled', 'healthy', 'degraded', 'stale', 'never_succeeded', 'unavailable']),
  reason: AlertReasonSchema.nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  counts: EnkryptSyncCountsSchema.nullable(),
  lastSuccessCounts: EnkryptSyncCountsSchema.nullable(),
  baselineMatchedCount: z.number().int().nonnegative().nullable(),
  lastAlertAt: z.string().datetime().nullable(),
  lastAlertReason: AlertReasonSchema.nullable(),
  shouldAlert: z.boolean(),
});

type FailureCategory = 'configuration' | 'network' | 'upstream' | 'database' | 'unexpected';
type Delivery = 'not_needed' | 'suppressed' | 'simulated' | 'sent' | 'failed';

function captureFailure(caught: unknown): FailureCategory {
  const category =
    caught instanceof AdminSlackNotificationError &&
    (caught.kind === 'configuration' || caught.kind === 'network' || caught.kind === 'upstream')
      ? caught.kind
      : caught instanceof EnkryptSyncError && caught.category === 'database'
        ? 'database'
        : 'unexpected';
  captureException(new Error('Enkrypt health check operation failed'), {
    tags: { endpoint: 'cron/check-enkrypt-health', category },
  });
  return category;
}

export async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const target = process.env.VERCEL_TARGET_ENV ?? process.env.VERCEL_ENV;
  const run = createScheduledJobRun({
    jobName: 'web.check_enkrypt_health',
    environment: target ?? process.env.NODE_ENV,
  });
  let health: EnkryptSyncHealth;
  let category: FailureCategory | undefined;
  try {
    const parsed = HealthSchema.safeParse(await getEnkryptSyncHealth());
    if (!parsed.success) throw new EnkryptSyncError('unexpected');
    health = parsed.data;
  } catch (caught) {
    category = captureFailure(caught);
    health = {
      status: 'unavailable',
      reason: 'monitor_error',
      lastAttemptAt: null,
      lastSuccessAt: null,
      counts: null,
      lastSuccessCounts: null,
      baselineMatchedCount: null,
      lastAlertAt: null,
      lastAlertReason: null,
      shouldAlert: true,
    };
  }

  const healthy = health.status === 'healthy' || health.status === 'disabled';
  let delivery: Delivery = healthy ? 'not_needed' : 'suppressed';
  if (!healthy && health.shouldAlert && health.reason) {
    delivery = 'simulated';
    if (target === 'production') {
      const alertTimestamp = new Date().toISOString();
      try {
        await sendAdminSlackNotification(
          {
            text: `Enkrypt synchronization health alert: ${health.reason}. Check the Enkrypt sync and health jobs.\n${JSON.stringify(
              {
                status: health.status,
                lastAttemptAt: health.lastAttemptAt,
                lastSuccessAt: health.lastSuccessAt,
                counts: health.counts,
                lastSuccessCounts: health.lastSuccessCounts,
                baselineMatchedCount: health.baselineMatchedCount,
              }
            )}`,
            unfurl_links: false,
            unfurl_media: false,
          },
          { requireConfigured: true }
        );
        await recordEnkryptSyncAlert(health.reason, alertTimestamp);
        delivery = 'sent';
      } catch (caught) {
        category = captureFailure(caught);
        delivery = 'failed';
      }
    }
  }

  const metadata = {
    status: health.status,
    reason: health.reason ?? undefined,
    category,
    delivery,
    skipped: health.status === 'disabled',
    last_attempt_at: health.lastAttemptAt ?? undefined,
    last_success_at: health.lastSuccessAt ?? undefined,
    last_alert_at: health.lastAlertAt ?? undefined,
    last_alert_reason: health.lastAlertReason ?? undefined,
    baseline_matched_count: health.baselineMatchedCount ?? undefined,
    fetched_count: health.counts?.fetchedCount,
    rejected_count: health.counts?.rejectedCount,
    matched_count: health.counts?.matchedCount,
    unmatched_count: health.counts?.unmatchedCount,
    ambiguous_count: health.counts?.ambiguousCount,
    updated_count: health.counts?.updatedCount,
  };
  emitScheduledJobEvent(
    healthy
      ? buildScheduledJobSuccessEvent(run, metadata)
      : buildScheduledJobFailureEvent({
          context: run,
          jobName: run.jobName,
          environment: run.environment,
          error: new Error('Enkrypt synchronization is unhealthy'),
          metadata,
        })
  );
  return NextResponse.json(
    { ...health, delivery, ...(category === undefined ? {} : { category }) },
    { status: healthy ? 200 : 503, headers }
  );
}
