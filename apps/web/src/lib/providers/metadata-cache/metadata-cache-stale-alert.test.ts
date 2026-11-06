import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { AdminSlackNotification } from '@kilocode/web-shared/lib/slack/admin-notifications';
import { SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS } from '@/lib/providers/openrouter/sync-providers-stale-alert';
import {
  alertIfMetadataCacheStale,
  buildMetadataCacheStaleAlertNotification,
  METADATA_CACHE_STALE_AFTER_MS,
  shouldPostMetadataCacheStaleAlert,
  type StaleMetadataEntry,
} from './metadata-cache-stale-alert';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const ALERT_TTL_MS = SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS * 1000;
const RECENT_ALERT = new Date(NOW.getTime() - 60 * 60 * 1000);
const EXPIRED_ALERT = new Date(NOW.getTime() - ALERT_TTL_MS);

function entry(url: string, updatedAt: Date | null): StaleMetadataEntry {
  return { url, updatedAt };
}

const STALE_BEFORE_RECENT_ALERT_AT = new Date(
  RECENT_ALERT.getTime() - METADATA_CACHE_STALE_AFTER_MS
);
const staleBeforeRecentAlert = entry('https://metadata.test/old', STALE_BEFORE_RECENT_ALERT_AT);
const staleAfterRecentAlert = entry(
  'https://metadata.test/new',
  new Date(RECENT_ALERT.getTime() - METADATA_CACHE_STALE_AFTER_MS + 1)
);
const neverStored = entry('https://metadata.test/never', null);

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_AGO_2 = new Date(NOW.getTime() - 2 * DAY_MS);
const DAYS_AGO_3 = new Date(NOW.getTime() - 3 * DAY_MS);
const GROUP = 'https://gateway.test/models/{id}/endpoints';

function groupedEntry(modelId: string, updatedAt: Date | null): StaleMetadataEntry {
  return { url: `https://gateway.test/models/${modelId}/endpoints`, updatedAt, group: GROUP };
}

function postedNotification() {
  return jest.fn(async (_notification: AdminSlackNotification) => 'posted' as const);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('shouldPostMetadataCacheStaleAlert', () => {
  it('does not alert without stale entries', () => {
    expect(
      shouldPostMetadataCacheStaleAlert({ staleEntries: [], lastAlertAt: null, now: NOW })
    ).toBe(false);
  });

  it('alerts when no alert has been posted', () => {
    expect(
      shouldPostMetadataCacheStaleAlert({
        staleEntries: [neverStored],
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(true);
  });

  it('does not alert again within the TTL for entries that were already stale', () => {
    expect(
      shouldPostMetadataCacheStaleAlert({
        staleEntries: [staleBeforeRecentAlert, neverStored],
        lastAlertAt: RECENT_ALERT,
        now: NOW,
      })
    ).toBe(false);
  });

  it('alerts within the TTL when an entry became stale after the last alert', () => {
    expect(
      shouldPostMetadataCacheStaleAlert({
        staleEntries: [staleBeforeRecentAlert, staleAfterRecentAlert],
        lastAlertAt: RECENT_ALERT,
        now: NOW,
      })
    ).toBe(true);
  });

  it('alerts again once the last alert has expired', () => {
    expect(
      shouldPostMetadataCacheStaleAlert({
        staleEntries: [staleBeforeRecentAlert],
        lastAlertAt: EXPIRED_ALERT,
        now: NOW,
      })
    ).toBe(true);
  });
});

describe('buildMetadataCacheStaleAlertNotification', () => {
  it('lists at most ten sources and summarizes the rest', () => {
    const staleEntries = Array.from({ length: 12 }, (_, index) =>
      entry(`https://metadata.test/source-${index}`, null)
    );

    const notification = buildMetadataCacheStaleAlertNotification({ staleEntries, now: NOW });
    const blocks = JSON.stringify(notification.blocks);

    expect(notification.text).toContain('12 upstream metadata sources failed to refresh and are');
    expect(notification.text).toContain('Important, not urgent');
    expect(blocks).toContain('https://metadata.test/source-9');
    expect(blocks).not.toContain('https://metadata.test/source-10');
    expect(blocks).toContain('• and 2 more');
    expect(blocks).toContain('/admin/gateway|Open Gateway admin');
  });

  it('describes a single source with its last update', () => {
    const notification = buildMetadataCacheStaleAlertNotification({
      staleEntries: [staleBeforeRecentAlert],
      now: NOW,
    });
    const blocks = JSON.stringify(notification.blocks);

    expect(notification.text).toContain('1 upstream metadata source failed to refresh and is');
    expect(blocks).toContain(STALE_BEFORE_RECENT_ALERT_AT.toISOString());
    expect(blocks).not.toMatch(/and \d+ more/);
  });

  it('marks sources that were never stored', () => {
    const notification = buildMetadataCacheStaleAlertNotification({
      staleEntries: [neverStored],
      now: NOW,
    });

    expect(JSON.stringify(notification.blocks)).toContain('never stored');
  });

  it('lists entries sharing a group as one line with their count and oldest update', () => {
    const notification = buildMetadataCacheStaleAlertNotification({
      staleEntries: [
        groupedEntry('a', DAYS_AGO_2),
        groupedEntry('b', DAYS_AGO_3),
        groupedEntry('c', DAYS_AGO_2),
        entry('https://metadata.test/plain', DAYS_AGO_2),
        {
          url: 'https://other.test/models/x/endpoints',
          updatedAt: DAYS_AGO_3,
          group: 'https://other.test/models/{id}/endpoints',
        },
      ],
      now: NOW,
    });
    const blocks = JSON.stringify(notification.blocks);

    expect(notification.text).toContain('5 upstream metadata sources failed to refresh');
    expect(blocks).toContain(
      `• \`${GROUP}\` for 3 sources (oldest last updated: ${DAYS_AGO_3.toISOString()})`
    );
    expect(blocks).not.toContain('https://gateway.test/models/a/endpoints');
    expect(blocks).toContain(
      `• \`https://metadata.test/plain\` (last updated: ${DAYS_AGO_2.toISOString()})`
    );
    expect(blocks).toContain(
      `• \`https://other.test/models/x/endpoints\` (last updated: ${DAYS_AGO_3.toISOString()})`
    );
    expect(blocks).not.toContain('https://other.test/models/{id}/endpoints');
  });

  it('marks a group as never stored when any of its entries was never stored', () => {
    const notification = buildMetadataCacheStaleAlertNotification({
      staleEntries: [groupedEntry('a', DAYS_AGO_3), groupedEntry('b', null)],
      now: NOW,
    });

    expect(JSON.stringify(notification.blocks)).toContain(
      `• \`${GROUP}\` for 2 sources (oldest last updated: never stored)`
    );
  });

  it('counts listed lines rather than entries when summarizing the rest', () => {
    const staleEntries = [
      ...['a', 'b', 'c', 'd', 'e'].map(id => groupedEntry(id, DAYS_AGO_2)),
      ...Array.from({ length: 11 }, (_, index) =>
        entry(`https://metadata.test/source-${index}`, null)
      ),
    ];

    const notification = buildMetadataCacheStaleAlertNotification({ staleEntries, now: NOW });
    const blocks = JSON.stringify(notification.blocks);

    expect(notification.text).toContain('16 upstream metadata sources failed to refresh');
    expect(blocks).toContain(`\`${GROUP}\` for 5 sources`);
    expect(blocks).toContain('https://metadata.test/source-8`');
    expect(blocks).not.toContain('https://metadata.test/source-9`');
    expect(blocks).toContain('• and 2 more');
  });
});

describe('alertIfMetadataCacheStale', () => {
  it('posts and stores the alert timestamp', async () => {
    const sendNotification = postedNotification();
    const setLastAlertAt = jest.fn(async (_iso: string) => undefined);

    await alertIfMetadataCacheStale([neverStored], {
      now: () => NOW,
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledWith(
      buildMetadataCacheStaleAlertNotification({ staleEntries: [neverStored], now: NOW })
    );
    expect(setLastAlertAt).toHaveBeenCalledWith(NOW.toISOString());
  });

  it('does not store the alert timestamp for a simulated delivery', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'simulated' as const
    );
    const setLastAlertAt = jest.fn(async (_iso: string) => undefined);

    await alertIfMetadataCacheStale([neverStored], {
      now: () => NOW,
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('does not read alert state without stale entries', async () => {
    const getLastAlertAt = jest.fn(async () => null);
    const sendNotification = postedNotification();

    await alertIfMetadataCacheStale([], { getLastAlertAt, sendNotification });

    expect(getLastAlertAt).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does not post when a recent alert already covered the stale entries', async () => {
    const sendNotification = postedNotification();

    await alertIfMetadataCacheStale([staleBeforeRecentAlert], {
      now: () => NOW,
      getLastAlertAt: async () => RECENT_ALERT.toISOString(),
      sendNotification,
    });

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('swallows delivery failures without storing the alert timestamp', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const setLastAlertAt = jest.fn(async (_iso: string) => undefined);

    await expect(
      alertIfMetadataCacheStale([neverStored], {
        now: () => NOW,
        getLastAlertAt: async () => null,
        setLastAlertAt,
        sendNotification: async () => {
          throw new Error('slack down');
        },
      })
    ).resolves.toBeUndefined();
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('persists its own alert timestamp in the sync state row', async () => {
    await db
      .delete(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1));
    const sendNotification = postedNotification();

    await alertIfMetadataCacheStale([neverStored], { now: () => NOW, sendNotification });
    await alertIfMetadataCacheStale([neverStored], { now: () => NOW, sendNotification });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [state] = await db.select().from(ai_gateway_sync_providers_state);
    expect(new Date(state.metadata_cache_stale_alert_last_posted_at ?? '').toISOString()).toBe(
      NOW.toISOString()
    );
    expect(state.stale_alert_last_posted_at).toBeNull();
    expect(state.direct_byok_stale_alert_last_posted_at).toBeNull();
  });
});
