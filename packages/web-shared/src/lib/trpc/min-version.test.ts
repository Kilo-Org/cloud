import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockReadDb = {
  select: jest.fn(),
};
const mockCaptureException = jest.fn();
const limitMock = jest.fn<() => Promise<unknown>>();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: mockReadDb }));
jest.mock('@sentry/nextjs', () => ({ captureException: mockCaptureException }));

import { UpstreamApiError } from '@kilocode/web-shared/lib/trpc/transport';
import { FAILURE_BACKOFF_MS } from '../cached-fetch';
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
  const row = { ios: '1.0.4', android: '1.0.5' };

  test('returns the configured minimums on a successful read', async () => {
    limitMock.mockResolvedValueOnce([row]);
    await expect(getMinimumVersions()).resolves.toEqual(row);
  });

  test('caches a "no row" read for the shorter no-row window', async () => {
    limitMock.mockResolvedValue([]);
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      await expect(getMinimumVersions()).resolves.toBeNull();

      nowSpy.mockReturnValue(start + 30_000 - 1);
      await expect(getMinimumVersions()).resolves.toBeNull();
      expect(limitMock).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(start + 30_000 + 1);
      await expect(getMinimumVersions()).resolves.toBeNull();
      expect(limitMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('stops waiting for a read that never settles without starting another', async () => {
    jest.useFakeTimers();
    try {
      const stuck = Promise.withResolvers<unknown>();
      limitMock.mockReturnValue(stuck.promise);

      const first = getMinimumVersions().catch((caught: unknown) => caught);
      // The gate waits 5s for one read before giving the caller an answer.
      await jest.advanceTimersByTimeAsync(5_000);

      const error = await first;
      if (!error || typeof error !== 'object' || !('code' in error)) {
        throw new Error('expected getMinimumVersions to reject with a TRPCError');
      }
      expect(error.code).toBe('SERVICE_UNAVAILABLE');
      // Nothing failed yet, so nothing was reported.
      expect(mockCaptureException).not.toHaveBeenCalled();

      // Inside the window the gate answers without waiting on the stuck read.
      await expect(getMinimumVersions()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(limitMock).toHaveBeenCalledTimes(1);

      // When the stuck read finally fails it reports once, and no second read
      // was ever issued alongside it.
      stuck.reject(new Error('db down'));
      await jest.advanceTimersByTimeAsync(0);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(limitMock).toHaveBeenCalledTimes(1);

      // After the window a fresh read is allowed.
      limitMock.mockResolvedValueOnce([row]);
      await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS + 1);
      await expect(getMinimumVersions()).resolves.toEqual(row);
      expect(limitMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('replaces a read that has been running past the age ceiling', async () => {
    jest.useFakeTimers();
    try {
      const stuck = Promise.withResolvers<unknown>();
      limitMock.mockReturnValueOnce(stuck.promise);

      const first = getMinimumVersions().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await first).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(limitMock).toHaveBeenCalledTimes(1);

      // Past the backoff window the stuck read is also past its age ceiling, so
      // the gate reads again instead of joining a read that never settles.
      limitMock.mockResolvedValueOnce([row]);
      await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS + 1);
      await expect(getMinimumVersions()).resolves.toEqual(row);
      expect(limitMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('starts no new read once the live reads are spent', async () => {
    jest.useFakeTimers();
    try {
      const firstStuck = Promise.withResolvers<unknown>();
      const secondStuck = Promise.withResolvers<unknown>();
      limitMock.mockReturnValueOnce(firstStuck.promise).mockReturnValueOnce(secondStuck.promise);

      const first = getMinimumVersions().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await first).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      // The second read also hangs and is waited on by its own caller.
      await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS + 1);
      const second = getMinimumVersions().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await second).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(limitMock).toHaveBeenCalledTimes(2);

      // Both reads still hold a connection, so the gate answers at once rather
      // than pinning a third one or waiting on a read that never settles.
      await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS + 1);
      const third = getMinimumVersions().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(0);
      expect(await third).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(limitMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a superseded read writes no cache over its replacement', async () => {
    jest.useFakeTimers();
    try {
      const superseded = Promise.withResolvers<unknown>();
      limitMock.mockReturnValueOnce(superseded.promise);

      const first = getMinimumVersions().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await first).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      // The replacement answers, and only then does the abandoned read settle
      // with an older verdict.
      await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS + 1);
      const replacementRow = { ios: '2.0.0', android: '2.0.0' };
      limitMock.mockResolvedValueOnce([replacementRow]);
      await expect(getMinimumVersions()).resolves.toEqual(replacementRow);

      superseded.resolve([row]);
      await jest.advanceTimersByTimeAsync(0);
      await expect(getMinimumVersions()).resolves.toEqual(replacementRow);
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a superseded read failure opens no backoff', async () => {
    jest.useFakeTimers();
    try {
      const superseded = Promise.withResolvers<unknown>();
      limitMock.mockReturnValueOnce(superseded.promise);

      const first = getMinimumVersions().catch((caught: unknown) => caught);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await first).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      await jest.advanceTimersByTimeAsync(FAILURE_BACKOFF_MS + 1);
      limitMock.mockResolvedValueOnce([row]);
      await expect(getMinimumVersions()).resolves.toEqual(row);

      // The abandoned read fails shortly before its replacement's entry expires.
      // It must neither report nor suppress the re-read the TTL asks for.
      await jest.advanceTimersByTimeAsync(300_000 - 2_000);
      superseded.reject(new Error('db down'));
      await jest.advanceTimersByTimeAsync(0);
      expect(mockCaptureException).not.toHaveBeenCalled();

      limitMock.mockResolvedValueOnce([row]);
      await jest.advanceTimersByTimeAsync(3_000);
      await expect(getMinimumVersions()).resolves.toEqual(row);
      expect(limitMock).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('shares one read between concurrent cold callers', async () => {
    limitMock.mockResolvedValue([row]);

    await expect(
      Promise.all([getMinimumVersions(), getMinimumVersions(), getMinimumVersions()])
    ).resolves.toEqual([row, row, row]);

    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  test('rejects with a retryable error when the read fails with nothing cached', async () => {
    limitMock.mockRejectedValue(new Error('db down'));

    const error = await getMinimumVersions().catch((caught: unknown) => caught);

    // The module under test is re-required after `resetModules`, so its
    // `TRPCError` class is a different instance than this file's import; read
    // the code the client would receive instead of comparing classes.
    if (!error || typeof error !== 'object' || !('code' in error)) {
      throw new Error('expected getMinimumVersions to reject with a TRPCError');
    }
    expect(error.code).toBe('SERVICE_UNAVAILABLE');
    // No `app_update_required` cause: the client must not read this as a verdict.
    expect('cause' in error ? error.cause : undefined).toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  test('backs off a failing read, reporting it once per window', async () => {
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      limitMock.mockRejectedValue(new Error('db down'));
      await expect(getMinimumVersions()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      nowSpy.mockReturnValue(start + FAILURE_BACKOFF_MS - 1);
      await expect(getMinimumVersions()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

      expect(limitMock).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);

      limitMock.mockResolvedValueOnce([row]);
      nowSpy.mockReturnValue(start + FAILURE_BACKOFF_MS + 1);
      await expect(getMinimumVersions()).resolves.toEqual(row);

      expect(limitMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('serves the last-known value without awaiting a failing read', async () => {
    limitMock.mockResolvedValueOnce([row]);
    await expect(getMinimumVersions()).resolves.toEqual(row);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000);
    try {
      limitMock.mockRejectedValueOnce(new Error('db down'));
      await expect(getMinimumVersions()).resolves.toEqual(row);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);

      await expect(getMinimumVersions()).resolves.toEqual(row);
      expect(limitMock).toHaveBeenCalledTimes(2);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
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
