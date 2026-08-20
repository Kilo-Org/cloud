import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockReadDb = {
  select: jest.fn(),
};
const mockCaptureException = jest.fn();
const limitMock = jest.fn<() => Promise<unknown>>();

jest.mock('@/lib/drizzle', () => ({ readDb: mockReadDb }));
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

import { UpstreamApiError } from '@/lib/trpc/transport';
import {
  appUpdateRequiredError,
  enforceMinimumVersion,
  isMobileClient,
  type MinimumVersionHeaders,
  type MinimumVersions,
} from './min-version';

// getMinimumVersions holds a module-level cache, so re-import for a fresh cache.
let getMinimumVersions: () => Promise<MinimumVersions | null>;

function headers(entries: Record<string, string>): MinimumVersionHeaders {
  return { get: (name: string) => entries[name] ?? null };
}

const minimums = { ios: '1.0.4', android: '1.0.5' };

beforeEach(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  getMinimumVersions = require('./min-version').getMinimumVersions;
  jest.clearAllMocks();
  mockReadDb.select.mockReturnValue({
    from: jest.fn().mockReturnValue({ limit: limitMock }),
  });
});

describe('isMobileClient', () => {
  test('is false for an absent or non-mobile client', () => {
    expect(isMobileClient(undefined)).toBe(false);
    expect(isMobileClient(null)).toBe(false);
    expect(isMobileClient(headers({}))).toBe(false);
    expect(isMobileClient(headers({ 'x-kilo-client': 'web' }))).toBe(false);
  });

  test('is true for a mobile client', () => {
    expect(isMobileClient(headers({ 'x-kilo-client': 'mobile' }))).toBe(true);
  });
});

describe('enforceMinimumVersion', () => {
  test('rejects a missing version', () => {
    expect(enforceMinimumVersion(headers({ 'x-kilo-app-platform': 'ios' }), minimums)).toEqual({
      pass: false,
    });
  });

  test('rejects an empty version', () => {
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'ios', 'x-kilo-app-version': '' }),
        minimums
      )
    ).toEqual({ pass: false });
  });

  test('rejects a malformed version', () => {
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'ios', 'x-kilo-app-version': 'abc' }),
        minimums
      )
    ).toEqual({ pass: false });
  });

  test('rejects an unknown platform', () => {
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'web', 'x-kilo-app-version': '1.0.4' }),
        minimums
      )
    ).toEqual({ pass: false });
  });

  test('rejects a version below the minimum', () => {
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'ios', 'x-kilo-app-version': '1.0.3' }),
        minimums
      )
    ).toEqual({ pass: false });
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'android', 'x-kilo-app-version': '1.0.4' }),
        minimums
      )
    ).toEqual({ pass: false });
  });

  test('passes at and above the minimum', () => {
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'ios', 'x-kilo-app-version': '1.0.4' }),
        minimums
      )
    ).toEqual({ pass: true });
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'ios', 'x-kilo-app-version': '1.0.5' }),
        minimums
      )
    ).toEqual({ pass: true });
    expect(
      enforceMinimumVersion(
        headers({ 'x-kilo-app-platform': 'android', 'x-kilo-app-version': '1.0.5' }),
        minimums
      )
    ).toEqual({ pass: true });
  });
});

describe('getMinimumVersions', () => {
  test('returns the configured minimums on a successful read', async () => {
    limitMock.mockResolvedValueOnce([{ ios: '1.0.4', android: '1.0.5' }]);
    await expect(getMinimumVersions()).resolves.toEqual({ ios: '1.0.4', android: '1.0.5' });
  });

  test('returns null when no row is configured', async () => {
    limitMock.mockResolvedValueOnce([]);
    await expect(getMinimumVersions()).resolves.toBeNull();
  });

  test('returns null when the read fails with no cache', async () => {
    limitMock.mockRejectedValueOnce(new Error('db down'));
    await expect(getMinimumVersions()).resolves.toBeNull();
    expect(mockCaptureException).toHaveBeenCalled();
  });

  test('uses the stale cache when a read fails after the TTL expires', async () => {
    limitMock.mockResolvedValueOnce([{ ios: '1.0.4', android: '1.0.5' }]);
    await expect(getMinimumVersions()).resolves.toEqual({ ios: '1.0.4', android: '1.0.5' });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000);
    try {
      limitMock.mockRejectedValueOnce(new Error('db down'));
      await expect(getMinimumVersions()).resolves.toEqual({ ios: '1.0.4', android: '1.0.5' });
      expect(mockCaptureException).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('appUpdateRequiredError', () => {
  test('carries FORBIDDEN and the app_update_required upstream code', () => {
    const error = appUpdateRequiredError();
    expect(error.code).toBe('FORBIDDEN');
    expect(error.cause).toBeInstanceOf(UpstreamApiError);
    expect((error.cause as UpstreamApiError).upstreamCode).toBe('app_update_required');
  });
});
