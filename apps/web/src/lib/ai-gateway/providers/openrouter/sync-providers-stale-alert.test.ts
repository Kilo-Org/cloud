import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://app.kilo.ai',
}));

jest.mock('@/lib/slack/admin-notifications', () => ({
  sendAdminSlackNotification: jest.fn(),
}));

import type { AdminSlackNotification } from '@/lib/slack/admin-notifications';
import {
  alertIfSyncProvidersStale,
  buildStaleSyncAlertNotification,
  isLiveStaleSyncAlertDeliveryEnabled,
  parseIsoTimestamp,
  postTestStaleSyncAlert,
  shouldPostStaleSyncAlert,
  SYNC_PROVIDERS_STALE_AFTER_MS,
  SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS,
} from './sync-providers-stale-alert';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const FRESH_SYNC = new Date(NOW.getTime() - SYNC_PROVIDERS_STALE_AFTER_MS + 1);
const STALE_SYNC = new Date(NOW.getTime() - SYNC_PROVIDERS_STALE_AFTER_MS);
const OLDER_ALERT = new Date(STALE_SYNC.getTime() - 60_000);
const NEWER_ALERT = new Date(STALE_SYNC.getTime() + 60_000);

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

describe('isLiveStaleSyncAlertDeliveryEnabled', () => {
  it('is enabled only on Vercel production', () => {
    expect(isLiveStaleSyncAlertDeliveryEnabled('production')).toBe(true);
    expect(isLiveStaleSyncAlertDeliveryEnabled('preview')).toBe(false);
    expect(isLiveStaleSyncAlertDeliveryEnabled('development')).toBe(false);
    expect(isLiveStaleSyncAlertDeliveryEnabled(undefined)).toBe(false);
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
  it('includes models, providers, investigation guidance, and the admin link', () => {
    const notification = buildStaleSyncAlertNotification({
      lastCompletedAt: STALE_SYNC,
      now: NOW,
    });

    expect(notification.text).toContain(STALE_SYNC.toISOString());
    expect(notification.text).toContain('last 1 hour');
    expect(notification.text).toContain('Provider and model catalogs');
    expect(notification.text).toContain('New models and providers can be missing');
    expect(notification.text).toContain('Sentry and Vercel logs');
    expect(JSON.stringify(notification.blocks)).toContain('/admin/gateway|Open Gateway admin');
    expect(notification.text).not.toContain('[TEST]');
  });

  it('marks test alerts so they cannot be mistaken for a live page', () => {
    const notification = buildStaleSyncAlertNotification({
      lastCompletedAt: STALE_SYNC,
      now: NOW,
      kind: 'test',
    });

    expect(notification.text).toContain('[TEST]');
    expect(JSON.stringify(notification.blocks)).toContain('[TEST ALERT]');
    expect(JSON.stringify(notification.blocks)).toContain('Test alert posted at');
    expect(notification.text).toContain('Provider and model catalogs');
    expect(notification.text).toContain('Sentry and Vercel logs');
  });

  it('says never recorded when no full sync timestamp exists', () => {
    const notification = buildStaleSyncAlertNotification({
      lastCompletedAt: null,
      now: NOW,
    });

    expect(notification.text).toContain('never recorded');
  });
});

describe('alertIfSyncProvidersStale', () => {
  it('posts once and stores the alert timestamp with a week TTL', async () => {
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncProvidersStale({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
      isLiveDeliveryEnabled: () => true,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({ lastCompletedAt: STALE_SYNC, now: NOW })
    );
    expect(setLastAlertAt).toHaveBeenCalledWith(NOW.toISOString());
    expect(SYNC_PROVIDERS_STALE_ALERT_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(SYNC_PROVIDERS_STALE_AFTER_MS).toBe(60 * 60 * 1000);
  });

  it('does not post when a later alert already exists', async () => {
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncProvidersStale({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => NEWER_ALERT.toISOString(),
      setLastAlertAt,
      sendNotification,
      isLiveDeliveryEnabled: () => true,
    });

    expect(sendNotification).not.toHaveBeenCalled();
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });

  it('skips live delivery outside Vercel production', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);
    const setLastAlertAt = jest.fn(async (_iso: string) => 'OK');

    await alertIfSyncProvidersStale({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      getLastAlertAt: async () => null,
      setLastAlertAt,
      sendNotification,
      isLiveDeliveryEnabled: () => false,
    });

    expect(sendNotification).not.toHaveBeenCalled();
    expect(setLastAlertAt).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[sync-providers] skipping live stale-sync Slack alert outside Vercel production'
    );
  });

  it('swallows Redis failures so the cron can continue', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);

    await expect(
      alertIfSyncProvidersStale({
        now: () => NOW,
        getLastCompletedAt: async () => {
          throw new Error('redis down');
        },
        getLastAlertAt: async () => null,
        sendNotification,
        isLiveDeliveryEnabled: () => true,
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
        isLiveDeliveryEnabled: () => true,
        sendNotification: async () => {
          throw new Error('slack down');
        },
      })
    ).resolves.toBeUndefined();
    expect(setLastAlertAt).not.toHaveBeenCalled();
  });
});

describe('postTestStaleSyncAlert', () => {
  it('posts a clearly labeled test alert without writing the suppression timestamp', async () => {
    const sendNotification = jest.fn(async (_notification: AdminSlackNotification) => undefined);

    await postTestStaleSyncAlert({
      now: () => NOW,
      getLastCompletedAt: async () => STALE_SYNC.toISOString(),
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      buildStaleSyncAlertNotification({ lastCompletedAt: STALE_SYNC, now: NOW, kind: 'test' })
    );
  });
});
