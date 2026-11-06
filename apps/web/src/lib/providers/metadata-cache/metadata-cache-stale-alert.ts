import 'server-only';

import { captureException } from '@sentry/nextjs';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import type { AdminSlackNotification } from '@kilocode/web-shared/lib/slack/admin-notifications';
import {
  SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS,
  URGENCY_COPY,
  parseIsoTimestamp,
  readSyncStateColumn,
  sendStaleSyncAlertNotification,
  writeLatestSyncStateTimestamp,
  type StaleAlertDelivery,
} from '@/lib/providers/openrouter/sync-providers-stale-alert';

export const METADATA_CACHE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_ALERT_TTL_MS = SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS * 1000;
const MAX_LISTED_ENTRIES = 10;
const LAST_ALERT_COLUMN = 'metadata_cache_stale_alert_last_posted_at';

const TITLE = 'AI gateway metadata cache refresh';
const IMPACT =
  'Consumers keep using the last stored metadata, so new or changed models and providers may not appear.';
const INVESTIGATION =
  'Check Vercel logs for `[refresh-metadata-cache]` errors naming the listed sources.';

export type StaleMetadataEntry = {
  url: string;
  updatedAt: Date | null;
  /** Entries sharing a group, such as every model's endpoints on one gateway, are listed as one line. */
  group?: string;
};

export function shouldPostMetadataCacheStaleAlert(input: {
  staleEntries: ReadonlyArray<StaleMetadataEntry>;
  lastAlertAt: Date | null;
  now: Date;
}): boolean {
  const { staleEntries, lastAlertAt, now } = input;
  if (staleEntries.length === 0) return false;
  if (lastAlertAt === null || now.getTime() - lastAlertAt.getTime() >= STALE_ALERT_TTL_MS) {
    return true;
  }
  return staleEntries.some(
    entry =>
      entry.updatedAt !== null &&
      entry.updatedAt.getTime() + METADATA_CACHE_STALE_AFTER_MS > lastAlertAt.getTime()
  );
}

function describeUpdatedAt(updatedAt: Date | null) {
  return updatedAt ? updatedAt.toISOString() : 'never stored';
}

function oldestUpdatedAt(entries: ReadonlyArray<StaleMetadataEntry>) {
  const oldest = Math.min(
    ...entries.map(entry => entry.updatedAt?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
  return Number.isFinite(oldest) ? new Date(oldest) : null;
}

function describeEntries(key: string, entries: ReadonlyArray<StaleMetadataEntry>) {
  const [first] = entries;
  if (entries.length === 1 && first) {
    return `\`${first.url}\` (last updated: ${describeUpdatedAt(first.updatedAt)})`;
  }
  return `\`${key}\` for ${entries.length} sources (oldest last updated: ${describeUpdatedAt(oldestUpdatedAt(entries))})`;
}

function listEntries(staleEntries: ReadonlyArray<StaleMetadataEntry>) {
  const entriesByKey = Map.groupBy(staleEntries, entry => entry.group ?? entry.url);
  return [...entriesByKey].map(([key, entries]) => describeEntries(key, entries));
}

export function buildMetadataCacheStaleAlertNotification(input: {
  staleEntries: ReadonlyArray<StaleMetadataEntry>;
  now: Date;
}): AdminSlackNotification {
  const { staleEntries, now } = input;
  const lines = listEntries(staleEntries);
  const listed = lines.slice(0, MAX_LISTED_ENTRIES);
  const remaining = lines.length - listed.length;
  const sources = [...listed, ...(remaining > 0 ? [`and ${remaining} more`] : [])];
  const status = `${staleEntries.length} upstream metadata ${
    staleEntries.length === 1 ? 'source' : 'sources'
  } failed to refresh and ${staleEntries.length === 1 ? 'is' : 'are'} more than a day out of date.`;

  return {
    text: [`${TITLE} is delayed.`, status, IMPACT, URGENCY_COPY, INVESTIGATION].join(' '),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:large_yellow_circle: *${TITLE} is delayed*` },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Status:* ${status}`,
            `*Sources:*`,
            ...sources.map(source => `• ${source}`),
            `*Impact:* ${IMPACT}`,
            `*Urgency:* ${URGENCY_COPY}`,
            `*Follow-up:* ${INVESTIGATION}`,
          ].join('\n'),
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Checked at ${now.toISOString()} · <${APP_URL}/admin/gateway|Open Gateway admin>`,
          },
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

type MetadataCacheStaleAlertDependencies = {
  now?: () => Date;
  getLastAlertAt?: () => Promise<string | null>;
  setLastAlertAt?: (iso: string) => Promise<unknown>;
  sendNotification?: (notification: AdminSlackNotification) => Promise<StaleAlertDelivery>;
};

export async function alertIfMetadataCacheStale(
  staleEntries: ReadonlyArray<StaleMetadataEntry>,
  {
    now: nowFn = () => new Date(),
    getLastAlertAt = () => readSyncStateColumn(LAST_ALERT_COLUMN),
    setLastAlertAt = iso => writeLatestSyncStateTimestamp(LAST_ALERT_COLUMN, iso),
    sendNotification = sendStaleSyncAlertNotification,
  }: MetadataCacheStaleAlertDependencies = {}
): Promise<void> {
  if (staleEntries.length === 0) return;
  try {
    const now = nowFn();
    const lastAlertAt = parseIsoTimestamp(await getLastAlertAt());
    if (!shouldPostMetadataCacheStaleAlert({ staleEntries, lastAlertAt, now })) return;

    const delivery = await sendNotification(
      buildMetadataCacheStaleAlertNotification({ staleEntries, now })
    );
    if (delivery !== 'posted') return;
    await setLastAlertAt(now.toISOString());
  } catch (error) {
    console.error('[refresh-metadata-cache] stale metadata alert failed', error);
    captureException(error, { tags: { component: 'refresh-metadata-cache-stale-alert' } });
  }
}
