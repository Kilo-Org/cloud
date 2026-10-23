import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ai_gateway_sync_providers_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq } from 'drizzle-orm';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/constants', () => ({
  APP_URL: 'https://app.kilo.ai',
}));

import type { AdminSlackNotification } from '@kilocode/web-shared/lib/slack/admin-notifications';
import {
  alertIfSyncStale,
  buildStaleSyncAlertNotification,
  getSyncLastCompletedAt,
  parseIsoTimestamp,
  postTestStaleSyncAlert,
  recordSyncCompleted,
  sendStaleSyncAlertNotification,
  sendTestStaleSyncAlertNotification,
  shouldPostStaleSyncAlert,
  SYNC_PROVIDERS_STALE_AFTER_MS,
  SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS,
} from './sync-providers-stale-alert';

const originalVercelEnv = process.env.VERCEL_ENV;
const NOW = new Date('2026-08-12T12:00:00.000Z');
const FRESH_SYNC = new Date(NOW.getTime() - SYNC_PROVIDERS_STALE_AFTER_MS + 1);
const STALE_SYNC = new Date(NOW.getTime() - SYNC_PROVIDERS_STALE_AFTER_MS);
const OLDER_ALERT = new Date(STALE_SYNC.getTime() - 60_000);
const NEWER_ALERT = new Date(STALE_SYNC.getTime() + 60_000);
const EXPIRED_ALERT = new Date(NOW.getTime() - SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS * 1000);

afterEach(() => {
  jest.restoreAllMocks();
  if (originalVercelEnv === undefined) {
    delete process.env.VERCEL_ENV;
  } else {
    process.env.VERCEL_ENV = originalVercelEnv;
  }
});

describe('parseIsoTimestamp', () => {
  it('returns null for missing or invalid values', () => {
    expect(parseIsoTimestamp(null)).toBeNull();
    expect(parseIsoTimestamp('')).toBeNull();
    expect(parseIsoTimestamp('not-a-date')).toBeNull();
  });

  it('parses ISO timestamps', () => {
    expect(parseIsoTimestamp('2026-08-11T12:00:00.000Z')).toEqual(
      new Date('2026-08-11T12:00:00.000Z')
    );
  });
});

describe('shouldPostStaleSyncAlert', () => {
  it('does not alert when the last full sync is less than 1 hour ago', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: FRESH_SYNC,
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(false);
  });

  it('alerts when the last full sync is at least 1 hour ago', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: STALE_SYNC,
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(true);
  });

  it('alerts when no full sync timestamp is recorded', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: null,
        lastAlertAt: null,
        now: NOW,
      })
    ).toBe(true);
  });

  it('does not alert when the last alert is after the last full sync', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: STALE_SYNC,
        lastAlertAt: NEWER_ALERT,
        now: NOW,
      })
    ).toBe(false);
  });

  it('does not alert again for a never-recorded sync after an alert', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: null,
        lastAlertAt: NOW,
        now: NOW,
      })
    ).toBe(false);
  });

  it('alerts again when the last alert has expired', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: null,
        lastAlertAt: EXPIRED_ALERT,
        now: NOW,
      })
    ).toBe(true);
  });

  it('alerts again after a newer full sync goes stale', () => {
    expect(
      shouldPostStaleSyncAlert({
        lastCompletedAt: STALE_SYNC,
        lastAlertAt: OLDER_ALERT,
        now: NOW,
      })
    ).toBe(true);
  });
});

describe('buildStaleSyncAlertNotification', () => {
  it('frames the delay as important but not urgent and includes follow-up guidance', () => {
    const notification = buildStaleSyncAlertNotification({
      jobId: 'providers',
      lastCompletedAt: STALE_SYNC,
      now: NOW,
    });

    expect(notification.text).toContain(STALE_SYNC.toISOString());
    expect(notification.text).toContain('Provider/model catalog sync is delayed');
    expect(notification.text).toContain('within the past hour');
    expect(notification.text).toContain('existing catalog data remains available');
    expect(notification.text).toContain('Important, not urgent');
    expect(notification.text).toContain('Some delay is acceptable');
    expect(notification.text).toContain('During normal operations');
    expect(notification.text).toContain('Sentry');
    expect(notification.text).toContain('Vercel logs');
    expect(JSON.stringify(notification.blocks)).toContain('/admin/gateway|Open Gateway admin');
    expect(JSON.stringify(notification.blocks)).toContain(':large_yellow_circle:');
    expect(JSON.stringify(notification.blocks)).not.toContain(':rotating_light:');
    expect(notification.text).not.toContain('[TEST]');
  });

  it('makes clear that test alerts verify delivery and do not indicate an active issue', () => {
    const notification = buildStaleSyncAlertNotification({
      jobId: 'providers',
      lastCompletedAt: STALE_SYNC,
      now: NOW,
      kind: 'test',
    });

    expect(notification.text).toContain('[TEST] Provider/model catalog sync delay notification');
    expect(notification.text).toContain('verifies alert delivery only');
    expect(notification.text).toContain('does not indicate an active issue');
    expect(JSON.stringify(notification.blocks)).toContain('*Test only:*');
    expect(JSON.stringify(notification.blocks)).toContain(':large_yellow_circle:');
    expect(JSON.stringify(notification.blocks)).not.toContain(':rotating_light:');
  });

  it('says never recorded when no full sync timestamp exists', () => {
    const notification = buildStaleSyncAlertNotification({
      jobId: 'providers',
      lastCompletedAt: null,
      now: NOW,
    });

    expect(notification.text).toContain('never recorded');
  });

  it('describes the direct BYOK sync with its own job and log names', () => {
    const notification = buildStaleSyncAlertNotification({
      jobId: 'direct_byok',
      lastCompletedAt: STALE_SYNC,
      now: NOW,
    });

    expect(notification.text).toContain('Direct BYOK model list sync is delayed');
    expect(notification.text).toContain('within the past hour');
    expect(notification.text).toContain('existing direct BYOK model lists remain available');
    expect(notification.text).toContain('`web.sync_direct_byok_providers`');
    expect(notification.text).toContain('`[sync-direct-byok-providers]`');
    expect(notification.text).not.toContain('Provider/model catalog sync');
  });
});

describe('sendStaleSyncAlertNotification', () => {
  const notification = { text: 'Test stale-sync alert' };

  it('simulates the Cloud alert outside production Vercel', async () => {
    process.env.VERCEL_ENV = 'preview';
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification, _options?: { requireConfigured?: boolean }) =>
        undefined
    );

    await expect(sendStaleSyncAlertNotification(notification, { sendNotification })).resolves.toBe(
      'simulated'
    );

    expect(sendNotification).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[sync-providers] Simulated Cloud alert; Slack delivery is enabled only on production Vercel',
      notification
    );
  });

  it('uses the required Cloud alert channel webhook in production Vercel', async () => {
    process.env.VERCEL_ENV = 'production';
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification, _options?: { requireConfigured?: boolean }) =>
        undefined
    );

    await expect(sendStaleSyncAlertNotification(notification, { sendNotification })).resolves.toBe(
      'posted'
    );

    expect(sendNotification).toHaveBeenCalledWith(notification, {
      requireConfigured: true,
    });
  });
});

describe('sendTestStaleSyncAlertNotification', () => {
  it('posts to the required Cloud alert webhook outside production Vercel', async () => {
    process.env.VERCEL_ENV = 'development';
    const notification = { text: 'Test stale-sync alert' };
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification, _options?: { requireConfigured?: boolean }) =>
        undefined
    );

    await expect(sendTestStaleSyncAlertNotification(notification, sendNotification)).resolves.toBe(
      'posted'
    );

    expect(sendNotification).toHaveBeenCalledWith(notification, {
      requireConfigured: true,
    });
  });
});

describe('alertIfSyncStale', () => {
  it('posts once and stores the alert timestamp with a three-day TTL', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncStale('providers', {
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({ jobId: 'providers', lastCompletedAt: STALE_SYNC, now: NOW })
    );
    expect(setLastAlertAt).toHaveBeenCalledWith(NOW.toISOString());
    expect(SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS).toBe(3 * 24 * 60 * 60);
    expect(SYNC_PROVIDERS_STALE_AFTER_MS).toBe(60 * 60 * 1000);
  });

  it('does not post when a later alert already exists', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncStale('providers', {
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => NEWER_ALERT.toISOString(),
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).not.toHaveBeenCalled();
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('swallows state read failures so the cron can continue', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );

    await expect(
      alertIfSyncStale('providers', {
        now: () => NOW,
        getLastCompletedAt: async () => {
          throw new Error('database down');
        },
        getLastAlertAt: async () => null,
        sendNotification,
      })
    ).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does not store an alert timestamp when Slack fails', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await expect(
      alertIfSyncStale('providers', {
        now: () => NOW,
        getLastCompletedAt: async () => STALE_SYNC.toISOString(),
        getLastAlertAt: async () => null,
        setLastAlertAt,
        sendNotification: async () => {
          throw new Error('slack down');
        },
      })
    ).resolves.toBeUndefined();
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('does not store an alert timestamp for a local simulation', async () => {
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'simulated' as const
    );

    await alertIfSyncStale('providers', {
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('posts the direct BYOK notification for the direct BYOK job', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncStale('direct_byok', {
      now: () => NOW,
      getLastCompletedAt: async () => null,
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({ jobId: 'direct_byok', lastCompletedAt: null, now: NOW })
    );
    expect(setLastAlertAt).toHaveBeenCalledWith(NOW.toISOString());
  });
});

describe('sync state persistence', () => {
  beforeEach(async () => {
    await db
      .delete(ai_gateway_sync_providers_state)
      .where(eq(ai_gateway_sync_providers_state.id, 1));
  });

  async function readSyncState() {
    const [row] = await db.select().from(ai_gateway_sync_providers_state);
    return row;
  }

  it('records completion per job without touching the other job', async () => {
    const providersCompletedAt = await recordSyncCompleted('providers');
    const before = await readSyncState();
    expect(new Date(before.last_completed_at ?? '').toISOString()).toBe(providersCompletedAt);
    expect(before.direct_byok_last_completed_at).toBeNull();

    const directByokCompletedAt = await recordSyncCompleted('direct_byok');
    const after = await readSyncState();
    expect(new Date(after.direct_byok_last_completed_at ?? '').toISOString()).toBe(
      directByokCompletedAt
    );
    expect(new Date(after.last_completed_at ?? '').toISOString()).toBe(providersCompletedAt);
    await expect(getSyncLastCompletedAt('direct_byok')).resolves.not.toBeNull();
  });

  it('stores and reads the direct BYOK alert timestamp separately', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );
    await db
      .insert(ai_gateway_sync_providers_state)
      .values({ id: 1, last_completed_at: NOW.toISOString() });

    await alertIfSyncStale('direct_byok', { now: () => NOW, sendNotification });
    await alertIfSyncStale('direct_byok', { now: () => NOW, sendNotification });
    await alertIfSyncStale('providers', { now: () => NOW, sendNotification });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const state = await readSyncState();
    expect(new Date(state.direct_byok_stale_alert_last_posted_at ?? '').toISOString()).toBe(
      NOW.toISOString()
    );
    expect(state.stale_alert_last_posted_at).toBeNull();
  });
});

describe('postTestStaleSyncAlert', () => {
  it('posts a clearly labeled test alert without writing the suppression timestamp', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );

    await expect(
      postTestStaleSyncAlert('providers', {
        now: () => NOW,
        getLastCompletedAt: async () => STALE_SYNC.toISOString(),
        sendNotification,
      })
    ).resolves.toBe('posted');

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({
        jobId: 'providers',
        lastCompletedAt: STALE_SYNC,
        now: NOW,
        kind: 'test',
      })
    );
  });
});
