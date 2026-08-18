import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://app.kilo.ai',
}));

jest.mock('@/lib/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

import type { AdminSlackNotification } from '@/lib/slack/admin-notifications';
import {
  alertIfSyncProvidersStale,
  buildStaleSyncAlertNotification,
  parseIsoTimestamp,
  postTestStaleSyncAlert,
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
      lastCompletedAt: null,
      now: NOW,
    });

    expect(notification.text).toContain('never recorded');
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

describe('alertIfSyncProvidersStale', () => {
  it('posts once and stores the alert timestamp with a three-day TTL', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncProvidersStale({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({ lastCompletedAt: STALE_SYNC, now: NOW })
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

    await alertIfSyncProvidersStale({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => NEWER_ALERT.toISOString(),
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).not.toHaveBeenCalled();
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('swallows Redis failures so the cron can continue', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );

    await expect(
      alertIfSyncProvidersStale({
        now: () => NOW,
        getLastCompletedAt: async () => {
          throw new Error('redis down');
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
      alertIfSyncProvidersStale({
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

    await alertIfSyncProvidersStale({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });
});

describe('postTestStaleSyncAlert', () => {
  it('posts a clearly labeled test alert without writing the suppression timestamp', async () => {
    const sendNotification = jest.fn(
      async (_notification: AdminSlackNotification) => 'posted' as const
    );

    await expect(
      postTestStaleSyncAlert({
        now: () => NOW,
        getLastCompletedAt: async () => STALE_SYNC.toISOString(),
        sendNotification,
      })
    ).resolves.toBe('posted');

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({ lastCompletedAt: STALE_SYNC, now: NOW, kind: 'test' })
    );
  });
});
