import 'server-only';

import { captureException } from '@sentry/nextjs';
import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  sendAdminSlackNotification,
  type AdminSlackNotification,
} from '@kilocode/web-shared/lib/slack/admin-notifications';
import { eq } from 'drizzle-orm';

export const SYNC_PROVIDERS_STALE_AFTER_MS = 60 * 60 * 1000;
export const SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS = 3 * 24 * 60 * 60;
const SYNC_PROVIDERS_STALE_ALERT_TTL_MS = SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS * 1000;

const STALE_WINDOW_LABEL = 'hour';
const URGENCY_COPY = 'Important, not urgent. Some delay is acceptable.';
const TEST_COPY = 'This verifies alert delivery only; it does not indicate an active issue.';

type SyncStateColumn = keyof Pick<
  typeof ai_gateway_sync_providers_state.$inferSelect,
  | 'last_completed_at'
  | 'stale_alert_last_posted_at'
  | 'direct_byok_last_completed_at'
  | 'direct_byok_stale_alert_last_posted_at'
>;

type SyncJob = {
  title: string;
  status: string;
  impact: string;
  investigation: string;
  logPrefix: string;
  sentryComponent: string;
  lastCompletedColumn: SyncStateColumn;
  lastAlertColumn: SyncStateColumn;
};

export const SYNC_JOBS = {
  providers: {
    title: 'Provider/model catalog sync',
    status: `No full sync has completed within the past ${STALE_WINDOW_LABEL}.`,
    impact:
      'New providers and models may take longer to appear; existing catalog data remains available.',
    investigation:
      'During normal operations, check Sentry for `web.sync_providers` and Vercel logs for `[sync-providers]` errors.',
    logPrefix: '[sync-providers]',
    sentryComponent: 'sync-providers-stale-alert',
    lastCompletedColumn: 'last_completed_at',
    lastAlertColumn: 'stale_alert_last_posted_at',
  },
  direct_byok: {
    title: 'Direct BYOK model list sync',
    status: `No direct BYOK model list sync has completed within the past ${STALE_WINDOW_LABEL}.`,
    impact:
      'New direct BYOK models may take longer to appear; existing direct BYOK model lists remain available.',
    investigation:
      'During normal operations, check Sentry for `web.sync_direct_byok_providers` and Vercel logs for `[sync-direct-byok-providers]` errors.',
    logPrefix: '[sync-direct-byok-providers]',
    sentryComponent: 'sync-direct-byok-providers-stale-alert',
    lastCompletedColumn: 'direct_byok_last_completed_at',
    lastAlertColumn: 'direct_byok_stale_alert_last_posted_at',
  },
} as const satisfies Record<string, SyncJob>;

export type SyncJobId = keyof typeof SYNC_JOBS;

export function parseIsoTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function shouldPostStaleSyncAlert(input: {
  lastCompletedAt: Date | null;
  lastAlertAt: Date | null;
  now: Date;
}): boolean {
  const { lastCompletedAt, lastAlertAt, now } = input;
  if (
    lastCompletedAt !== null &&
    now.getTime() - lastCompletedAt.getTime() < SYNC_PROVIDERS_STALE_AFTER_MS
  ) {
    return false;
  }
  if (
    lastAlertAt !== null &&
    (lastCompletedAt === null || lastAlertAt > lastCompletedAt) &&
    now.getTime() - lastAlertAt.getTime() < SYNC_PROVIDERS_STALE_ALERT_TTL_MS
  ) {
    return false;
  }
  return true;
}

export function buildStaleSyncAlertNotification(input: {
  jobId: SyncJobId;
  lastCompletedAt: Date | null;
  now: Date;
  kind?: 'live' | 'test';
}): AdminSlackNotification {
  const job: SyncJob = SYNC_JOBS[input.jobId];
  const kind = input.kind ?? 'live';
  const lastCompletedLabel = input.lastCompletedAt
    ? input.lastCompletedAt.toISOString()
    : 'never recorded';
  const headline =
    kind === 'test' ? `[TEST] ${job.title} delay notification.` : `${job.title} is delayed.`;
  const text = [
    headline,
    ...(kind === 'test' ? [TEST_COPY] : []),
    job.status,
    `Last completed: ${lastCompletedLabel}.`,
    job.impact,
    URGENCY_COPY,
    job.investigation,
  ].join(' ');

  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            kind === 'test'
              ? `:large_yellow_circle: *[TEST] ${job.title} delay notification*`
              : `:large_yellow_circle: *${job.title} is delayed*`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            ...(kind === 'test' ? [`*Test only:* ${TEST_COPY}`] : []),
            `*Status:* ${job.status}`,
            `*Last completed:* ${lastCompletedLabel}`,
            `*Impact:* ${job.impact}`,
            `*Urgency:* ${URGENCY_COPY}`,
            `*Follow-up:* ${job.investigation}`,
          ].join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text:
              kind === 'test'
                ? `Test generated at ${input.now.toISOString()} · <${APP_URL}/admin/gateway|Open Gateway admin>`
                : `Checked at ${input.now.toISOString()} · <${APP_URL}/admin/gateway|Open Gateway admin>`,
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

type StaleAlertDelivery = 'posted' | 'simulated';
type SendStaleAlertNotification = (
  notification: AdminSlackNotification
) => Promise<StaleAlertDelivery>;

type StaleAlertDeliveryOptions = {
  deliverOutsideProduction?: boolean;
  sendNotification?: typeof sendAdminSlackNotification;
};

export async function sendStaleSyncAlertNotification(
  notification: AdminSlackNotification,
  {
    deliverOutsideProduction = false,
    sendNotification = sendAdminSlackNotification,
  }: StaleAlertDeliveryOptions = {}
): Promise<StaleAlertDelivery> {
  if (process.env.VERCEL_ENV !== 'production' && !deliverOutsideProduction) {
    console.info(
      '[sync-providers] Simulated Cloud alert; Slack delivery is enabled only on production Vercel',
      notification
    );
    return 'simulated';
  }

  await sendNotification(notification, { requireConfigured: true, destination: 'gateway' });
  return 'posted';
}

export async function sendTestStaleSyncAlertNotification(
  notification: AdminSlackNotification,
  sendNotification = sendAdminSlackNotification
): Promise<'posted'> {
  await sendStaleSyncAlertNotification(notification, {
    deliverOutsideProduction: true,
    sendNotification,
  });
  return 'posted';
}

type StaleAlertDependencies = {
  now?: () => Date;
  getLastCompletedAt?: () => Promise<string | null>;
  getLastAlertAt?: () => Promise<string | null>;
  setLastAlertAt?: (iso: string) => Promise<unknown>;
  sendNotification?: SendStaleAlertNotification;
};

async function readSyncStateColumn(column: SyncStateColumn): Promise<string | null> {
  const [row] = await db
    .select({ value: ai_gateway_sync_providers_state[column] })
    .from(ai_gateway_sync_providers_state)
    .where(eq(ai_gateway_sync_providers_state.id, 1))
    .limit(1);
  return row?.value ?? null;
}

export function getSyncLastCompletedAt(jobId: SyncJobId): Promise<string | null> {
  return readSyncStateColumn(SYNC_JOBS[jobId].lastCompletedColumn);
}

async function writeLatestSyncStateTimestamp(column: SyncStateColumn, iso: string) {
  return db.transaction(async tx => {
    await tx.insert(ai_gateway_sync_providers_state).values({ id: 1 }).onConflictDoNothing();
    const [row] = await tx
      .select({ value: ai_gateway_sync_providers_state[column] })
      .from(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1))
      .for('update');
    if (!row) throw new Error('Sync-providers state row is missing');

    const current = parseIsoTimestamp(row.value);
    const requested = new Date(iso);
    const latestIso = current && current > requested ? current.toISOString() : iso;
    const patch: Partial<typeof ai_gateway_sync_providers_state.$inferInsert> = {};
    patch[column] = latestIso;
    await tx
      .update(ai_gateway_sync_providers_state)
      .set(patch)
      .where(eq(ai_gateway_sync_providers_state.id, 1));
    return latestIso;
  });
}

export async function recordSyncCompleted(jobId: SyncJobId): Promise<string> {
  const completedAt = new Date().toISOString();
  await writeLatestSyncStateTimestamp(SYNC_JOBS[jobId].lastCompletedColumn, completedAt);
  return completedAt;
}

export async function postStaleSyncAlert(input: {
  jobId: SyncJobId;
  lastCompletedAt: Date | null;
  now?: Date;
  kind?: 'live' | 'test';
  sendNotification?: SendStaleAlertNotification;
}): Promise<StaleAlertDelivery> {
  const now = input.now ?? new Date();
  const sendNotification = input.sendNotification ?? sendStaleSyncAlertNotification;
  return sendNotification(
    buildStaleSyncAlertNotification({
      jobId: input.jobId,
      lastCompletedAt: input.lastCompletedAt,
      now,
      kind: input.kind,
    })
  );
}

export async function postTestStaleSyncAlert(
  jobId: SyncJobId,
  {
    now: nowFn = () => new Date(),
    getLastCompletedAt = () => getSyncLastCompletedAt(jobId),
    sendNotification = sendTestStaleSyncAlertNotification,
  }: Pick<StaleAlertDependencies, 'now' | 'getLastCompletedAt' | 'sendNotification'> = {}
): Promise<StaleAlertDelivery> {
  const now = nowFn();
  const lastCompletedAt = parseIsoTimestamp(await getLastCompletedAt());
  return postStaleSyncAlert({
    jobId,
    lastCompletedAt,
    now,
    kind: 'test',
    sendNotification,
  });
}

export async function alertIfSyncStale(
  jobId: SyncJobId,
  {
    now: nowFn = () => new Date(),
    getLastCompletedAt = () => getSyncLastCompletedAt(jobId),
    getLastAlertAt = () => readSyncStateColumn(SYNC_JOBS[jobId].lastAlertColumn),
    setLastAlertAt = iso => writeLatestSyncStateTimestamp(SYNC_JOBS[jobId].lastAlertColumn, iso),
    sendNotification = sendStaleSyncAlertNotification,
  }: StaleAlertDependencies = {}
): Promise<void> {
  const job: SyncJob = SYNC_JOBS[jobId];
  try {
    const now = nowFn();
    const [lastCompletedRaw, lastAlertRaw] = await Promise.all([
      getLastCompletedAt(),
      getLastAlertAt(),
    ]);
    const lastCompletedAt = parseIsoTimestamp(lastCompletedRaw);
    const lastAlertAt = parseIsoTimestamp(lastAlertRaw);
    if (!shouldPostStaleSyncAlert({ lastCompletedAt, lastAlertAt, now })) return;

    const delivery = await postStaleSyncAlert({ jobId, lastCompletedAt, now, sendNotification });
    if (delivery !== 'posted') return;
    await setLastAlertAt(now.toISOString());
  } catch (error) {
    console.error(`${job.logPrefix} stale sync alert failed`, error);
    captureException(error, { tags: { component: job.sentryComponent } });
  }
}
