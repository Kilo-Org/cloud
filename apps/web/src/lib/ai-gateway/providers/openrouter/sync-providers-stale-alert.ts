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

export const SYNC_PROVIDERS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS = 7 * 24 * 60 * 60;

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
}): AdminSlackNotification {
  const lastCompletedLabel = input.lastCompletedAt
    ? input.lastCompletedAt.toISOString()
    : 'never recorded';
  const text = `Sync providers has not completed a full run in the last 24 hours. Last completed: ${lastCompletedLabel}.`;
  return {
    text,
    blocks: [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: `:rotating_light: *${text}*` },
      },
      {
        type: 'context' as const,
        elements: [
          {
            type: 'mrkdwn' as const,
            text: `Checked at ${input.now.toISOString()} · <${APP_URL}/admin/gateway|Open Gateway admin>`,
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

type StaleAlertDependencies = {
  now?: () => Date;
  getLastCompletedAt?: () => Promise<string | null>;
  getLastAlertAt?: () => Promise<string | null>;
  setLastAlertAt?: (iso: string) => Promise<unknown>;
  sendNotification?: typeof sendAdminSlackNotification;
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

export async function alertIfSyncProvidersStale({
  now: nowFn = () => new Date(),
  getLastCompletedAt = defaultGetLastCompletedAt,
  getLastAlertAt = defaultGetLastAlertAt,
  setLastAlertAt = defaultSetLastAlertAt,
  sendNotification = sendAdminSlackNotification,
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

    await sendNotification(buildStaleSyncAlertNotification({ lastCompletedAt, now }));
    await setLastAlertAt(now.toISOString());
  } catch (error) {
    console.error('[sync-providers] stale full-sync alert failed', error);
    captureException(error, { tags: { component: 'sync-providers-stale-alert' } });
  }
}
