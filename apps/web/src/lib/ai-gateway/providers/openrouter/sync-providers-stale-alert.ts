import 'server-only';

import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { redisClient } from '@/lib/redis';
import {
  SYNC_PROVIDERS_LAST_COMPLETED_AT_REDIS_KEY,
  SYNC_PROVIDERS_STALE_ALERT_LAST_POSTED_AT_REDIS_KEY,
} from '@/lib/redis-keys';
import {
  sendAdminSlackNotification,
  type AdminSlackNotification,
} from '@/lib/slack/admin-notifications';

export const SYNC_PROVIDERS_STALE_AFTER_MS = 60 * 60 * 1000;
export const SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS = 3 * 24 * 60 * 60;

const STALE_WINDOW_LABEL = 'hour';
const STATUS_COPY = `No full sync has completed within the past ${STALE_WINDOW_LABEL}.`;
const IMPACT_COPY =
  'New providers and models may take longer to appear; existing catalog data remains available.';
const URGENCY_COPY = 'Important, not urgent. A few hours of delay is acceptable.';
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
  if (lastAlertAt !== null && (lastCompletedAt === null || lastAlertAt > lastCompletedAt)) {
    return false;
  }
  return true;
}

export function buildStaleSyncAlertNotification(input: {
  lastCompletedAt: Date | null;
  now: Date;
  kind?: 'live' | 'test';
}): AdminSlackNotification {
  const kind = input.kind ?? 'live';
  const lastCompletedLabel = input.lastCompletedAt
    ? input.lastCompletedAt.toISOString()
    : 'never recorded';
  const headline =
    kind === 'test'
      ? '[TEST] Provider/model catalog sync delay notification.'
      : 'Provider/model catalog sync is delayed.';
  const text = [
    headline,
    ...(kind === 'test' ? [TEST_COPY] : []),
    STATUS_COPY,
    `Last completed: ${lastCompletedLabel}.`,
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
            `*Status:* ${STATUS_COPY}`,
            `*Last completed:* ${lastCompletedLabel}`,
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

export async function sendStaleSyncAlertNotification(
  notification: AdminSlackNotification,
  sendNotification = sendAdminSlackNotification
): Promise<StaleAlertDelivery> {
  if (process.env.VERCEL_ENV !== 'production') {
    console.info(
      '[sync-providers] Simulated Cloud alert; Slack delivery is enabled only on production Vercel',
      notification
    );
    return 'simulated';
  }

  await sendNotification(notification, { requireConfigured: true });
  return 'posted';
}

type StaleAlertDependencies = {
  now?: () => Date;
  getLastCompletedAt?: () => Promise<string | null>;
  getLastAlertAt?: () => Promise<string | null>;
  setLastAlertAt?: (iso: string) => Promise<unknown>;
  sendNotification?: SendStaleAlertNotification;
};

async function defaultGetLastCompletedAt(): Promise<string | null> {
  return redisClient.get<string>(SYNC_PROVIDERS_LAST_COMPLETED_AT_REDIS_KEY);
}

async function defaultGetLastAlertAt(): Promise<string | null> {
  return redisClient.get<string>(SYNC_PROVIDERS_STALE_ALERT_LAST_POSTED_AT_REDIS_KEY);
}

async function defaultSetLastAlertAt(iso: string): Promise<unknown> {
  return redisClient.set(SYNC_PROVIDERS_STALE_ALERT_LAST_POSTED_AT_REDIS_KEY, iso, {
    ex: SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS,
  });
}

export async function postStaleSyncAlert(input: {
  lastCompletedAt: Date | null;
  now?: Date;
  kind?: 'live' | 'test';
  sendNotification?: SendStaleAlertNotification;
}): Promise<StaleAlertDelivery> {
  const now = input.now ?? new Date();
  const sendNotification = input.sendNotification ?? sendStaleSyncAlertNotification;
  return sendNotification(
    buildStaleSyncAlertNotification({
      lastCompletedAt: input.lastCompletedAt,
      now,
      kind: input.kind,
    })
  );
}

export async function postTestStaleSyncAlert({
  now: nowFn = () => new Date(),
  getLastCompletedAt = defaultGetLastCompletedAt,
  sendNotification = sendStaleSyncAlertNotification,
}: Pick<
  StaleAlertDependencies,
  'now' | 'getLastCompletedAt' | 'sendNotification'
> = {}): Promise<StaleAlertDelivery> {
  const now = nowFn();
  const lastCompletedAt = parseIsoTimestamp(await getLastCompletedAt());
  return postStaleSyncAlert({
    lastCompletedAt,
    now,
    kind: 'test',
    sendNotification,
  });
}

export async function alertIfSyncProvidersStale({
  now: nowFn = () => new Date(),
  getLastCompletedAt = defaultGetLastCompletedAt,
  getLastAlertAt = defaultGetLastAlertAt,
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

    const delivery = await postStaleSyncAlert({ lastCompletedAt, now, sendNotification });
    if (delivery !== 'posted') return;
    await setLastAlertAt(now.toISOString());
  } catch (error) {
    console.error('[sync-providers] stale full-sync alert failed', error);
    captureException(error, { tags: { component: 'sync-providers-stale-alert' } });
  }
}
