import 'server-only';

import { captureException } from '@sentry/nextjs';
import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import type { SyncProvidersRefreshFailures } from '@kilocode/db/schema-types';
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
const STATUS_COPY = `No full sync has completed within the past ${STALE_WINDOW_LABEL}.`;
const STALE_ENTRIES_STATUS_COPY = `Some catalog entries have not refreshed within the past ${STALE_WINDOW_LABEL}; their previous data remains in use.`;
const MAX_LISTED_REFRESH_FAILURES = 5;
const IMPACT_COPY =
  'New providers and models may take longer to appear; existing catalog data remains available.';
const URGENCY_COPY = 'Important, not urgent. Some delay is acceptable.';
const INVESTIGATION_COPY =
  'During normal operations, check Sentry for `web.sync_providers` and Vercel logs for `[sync-providers]` errors.';
const TEST_COPY = 'This verifies alert delivery only; it does not indicate an active issue.';

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

export type SyncFailureDetails = {
  lastFailedAt: Date | null;
  lastFailureMessage: string | null;
  refreshFailures: SyncProvidersRefreshFailures;
};

const NO_FAILURE_DETAILS: SyncFailureDetails = {
  lastFailedAt: null,
  lastFailureMessage: null,
  refreshFailures: {},
};

function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function describeFailures(input: {
  lastCompletedAt: Date | null;
  now: Date;
  details: SyncFailureDetails;
}) {
  const { lastCompletedAt, now, details } = input;
  const latestFailedRun =
    details.lastFailedAt &&
    details.lastFailureMessage &&
    (lastCompletedAt === null || details.lastFailedAt > lastCompletedAt)
      ? `${details.lastFailedAt.toISOString()}: ${details.lastFailureMessage}`
      : null;

  const refreshFailures = Object.entries(details.refreshFailures)
    .map(([entry, failure]) => ({ entry, ...failure, sinceDate: parseIsoTimestamp(failure.since) }))
    .sort((a, b) => (a.sinceDate?.getTime() ?? 0) - (b.sinceDate?.getTime() ?? 0));
  const hasStaleEntries = refreshFailures.some(
    failure =>
      failure.sinceDate !== null &&
      now.getTime() - failure.sinceDate.getTime() >= SYNC_PROVIDERS_STALE_AFTER_MS
  );
  const listedRefreshFailures = refreshFailures
    .slice(0, MAX_LISTED_REFRESH_FAILURES)
    .map(
      failure =>
        `${failure.entry} since ${failure.sinceDate?.toISOString() ?? failure.since}: ${failure.error}`
    );
  const unlistedCount = refreshFailures.length - listedRefreshFailures.length;

  return {
    status: hasStaleEntries ? STALE_ENTRIES_STATUS_COPY : STATUS_COPY,
    latestFailedRun,
    refreshFailureCount: refreshFailures.length,
    listedRefreshFailures: [
      ...listedRefreshFailures,
      ...(unlistedCount > 0 ? [`…and ${unlistedCount} more`] : []),
    ],
  };
}

export function buildStaleSyncAlertNotification(input: {
  lastCompletedAt: Date | null;
  now: Date;
  kind?: 'live' | 'test';
  details?: SyncFailureDetails;
}): AdminSlackNotification {
  const kind = input.kind ?? 'live';
  const lastCompletedLabel = input.lastCompletedAt
    ? input.lastCompletedAt.toISOString()
    : 'never recorded';
  const failures = describeFailures({
    lastCompletedAt: input.lastCompletedAt,
    now: input.now,
    details: input.details ?? NO_FAILURE_DETAILS,
  });
  const headline =
    kind === 'test'
      ? '[TEST] Provider/model catalog sync delay notification.'
      : 'Provider/model catalog sync is delayed.';
  const text = [
    headline,
    ...(kind === 'test' ? [TEST_COPY] : []),
    failures.status,
    `Last full refresh: ${lastCompletedLabel}.`,
    ...(failures.latestFailedRun ? [`Latest failed run: ${failures.latestFailedRun}.`] : []),
    ...(failures.refreshFailureCount > 0
      ? [
          `Entries using previous data (${failures.refreshFailureCount}): ${failures.listedRefreshFailures.join('; ')}.`,
        ]
      : []),
    IMPACT_COPY,
    URGENCY_COPY,
    INVESTIGATION_COPY,
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
              ? ':large_yellow_circle: *[TEST] Provider/model catalog sync delay notification*'
              : ':large_yellow_circle: *Provider/model catalog sync is delayed*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            ...(kind === 'test' ? [`*Test only:* ${TEST_COPY}`] : []),
            `*Status:* ${failures.status}`,
            `*Last full refresh:* ${lastCompletedLabel}`,
            ...(failures.latestFailedRun
              ? [`*Latest failed run:* ${escapeSlackText(failures.latestFailedRun)}`]
              : []),
            ...(failures.refreshFailureCount > 0
              ? [
                  `*Entries using previous data (${failures.refreshFailureCount}):*`,
                  ...failures.listedRefreshFailures.map(line => `• ${escapeSlackText(line)}`),
                ]
              : []),
            `*Impact:* ${IMPACT_COPY}`,
            `*Urgency:* ${URGENCY_COPY}`,
            `*Follow-up:* ${INVESTIGATION_COPY}`,
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

  await sendNotification(notification, { requireConfigured: true });
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
  getFailureDetails?: () => Promise<StoredSyncFailureDetails>;
  setLastAlertAt?: (iso: string) => Promise<unknown>;
  sendNotification?: SendStaleAlertNotification;
};

type StoredSyncFailureDetails = {
  lastFailedAt: string | null;
  lastFailureMessage: string | null;
  refreshFailures: SyncProvidersRefreshFailures;
};

async function defaultGetFailureDetails(): Promise<StoredSyncFailureDetails> {
  const [row] = await db
    .select({
      lastFailedAt: ai_gateway_sync_providers_state.last_failed_at,
      lastFailureMessage: ai_gateway_sync_providers_state.last_failure_message,
      refreshFailures: ai_gateway_sync_providers_state.refresh_failures,
    })
    .from(ai_gateway_sync_providers_state)
    .where(eq(ai_gateway_sync_providers_state.id, 1))
    .limit(1);
  return row ?? { lastFailedAt: null, lastFailureMessage: null, refreshFailures: {} };
}

async function getParsedFailureDetails(
  getFailureDetails: () => Promise<StoredSyncFailureDetails>
): Promise<SyncFailureDetails> {
  const details = await getFailureDetails();
  return { ...details, lastFailedAt: parseIsoTimestamp(details.lastFailedAt) };
}

async function defaultGetLastCompletedAt(): Promise<string | null> {
  const [row] = await db
    .select({ lastCompletedAt: ai_gateway_sync_providers_state.last_completed_at })
    .from(ai_gateway_sync_providers_state)
    .where(eq(ai_gateway_sync_providers_state.id, 1))
    .limit(1);
  return row?.lastCompletedAt ?? null;
}

async function defaultGetLastAlertAt(): Promise<string | null> {
  const [row] = await db
    .select({ lastAlertAt: ai_gateway_sync_providers_state.stale_alert_last_posted_at })
    .from(ai_gateway_sync_providers_state)
    .where(eq(ai_gateway_sync_providers_state.id, 1))
    .limit(1);
  return row?.lastAlertAt ?? null;
}

async function defaultSetLastAlertAt(iso: string): Promise<void> {
  await db.transaction(async tx => {
    await tx.insert(ai_gateway_sync_providers_state).values({ id: 1 }).onConflictDoNothing();
    const [row] = await tx
      .select({ lastAlertAt: ai_gateway_sync_providers_state.stale_alert_last_posted_at })
      .from(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1))
      .for('update');
    if (!row) throw new Error('Sync-providers state row is missing');

    const current = parseIsoTimestamp(row.lastAlertAt);
    const requested = new Date(iso);
    const latestIso = current && current > requested ? current.toISOString() : iso;
    await tx
      .update(ai_gateway_sync_providers_state)
      .set({ stale_alert_last_posted_at: latestIso })
      .where(eq(ai_gateway_sync_providers_state.id, 1));
  });
}

export async function postStaleSyncAlert(input: {
  lastCompletedAt: Date | null;
  now?: Date;
  kind?: 'live' | 'test';
  details?: SyncFailureDetails;
  sendNotification?: SendStaleAlertNotification;
}): Promise<StaleAlertDelivery> {
  const now = input.now ?? new Date();
  const sendNotification = input.sendNotification ?? sendStaleSyncAlertNotification;
  return sendNotification(
    buildStaleSyncAlertNotification({
      lastCompletedAt: input.lastCompletedAt,
      now,
      kind: input.kind,
      details: input.details,
    })
  );
}

export async function postTestStaleSyncAlert({
  now: nowFn = () => new Date(),
  getLastCompletedAt = defaultGetLastCompletedAt,
  getFailureDetails = defaultGetFailureDetails,
  sendNotification = sendTestStaleSyncAlertNotification,
}: Pick<
  StaleAlertDependencies,
  'now' | 'getLastCompletedAt' | 'getFailureDetails' | 'sendNotification'
> = {}): Promise<StaleAlertDelivery> {
  const now = nowFn();
  const [lastCompletedRaw, details] = await Promise.all([
    getLastCompletedAt(),
    getParsedFailureDetails(getFailureDetails),
  ]);
  return postStaleSyncAlert({
    lastCompletedAt: parseIsoTimestamp(lastCompletedRaw),
    now,
    kind: 'test',
    details,
    sendNotification,
  });
}

export async function alertIfSyncProvidersStale({
  now: nowFn = () => new Date(),
  getLastCompletedAt = defaultGetLastCompletedAt,
  getLastAlertAt = defaultGetLastAlertAt,
  getFailureDetails = defaultGetFailureDetails,
  setLastAlertAt = defaultSetLastAlertAt,
  sendNotification = sendStaleSyncAlertNotification,
}: StaleAlertDependencies = {}): Promise<void> {
  try {
    const now = nowFn();
    const [lastCompletedRaw, lastAlertRaw] = await Promise.all([
      getLastCompletedAt(),
      getLastAlertAt(),
    ]);
    const lastCompletedAt = parseIsoTimestamp(lastCompletedRaw);
    const lastAlertAt = parseIsoTimestamp(lastAlertRaw);
    if (!shouldPostStaleSyncAlert({ lastCompletedAt, lastAlertAt, now })) return;

    const details = await getParsedFailureDetails(getFailureDetails);
    const delivery = await postStaleSyncAlert({ lastCompletedAt, now, details, sendNotification });
    if (delivery !== 'posted') return;
    await setLastAlertAt(now.toISOString());
  } catch (error) {
    console.error('[sync-providers] stale full-sync alert failed', error);
    captureException(error, { tags: { component: 'sync-providers-stale-alert' } });
  }
}
