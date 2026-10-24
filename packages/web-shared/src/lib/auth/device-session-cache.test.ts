import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  DEVICE_SESSION_CACHE_TTL_MS,
  invalidateDeviceSession,
  isDeviceSessionActive,
  resetDeviceSessionCacheForTest,
} from './device-session-cache';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user_a';

let clock = 1_700_000_000_000;

beforeEach(() => {
  resetDeviceSessionCacheForTest();
  clock = 1_700_000_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('isDeviceSessionActive', () => {
  test('loads once for repeated lookups inside the TTL', async () => {
    const load = jest.fn(async () => true);

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(true);
    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(true);

    expect(load).toHaveBeenCalledTimes(1);
  });

  test('caches an inactive answer too', async () => {
    const load = jest.fn(async () => false);

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(false);
    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(false);

    expect(load).toHaveBeenCalledTimes(1);
  });

  test('reloads after the TTL and returns the new answer', async () => {
    let calls = 0;
    const load = jest.fn(async () => {
      calls += 1;
      return calls === 1;
    });

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(true);

    clock += DEVICE_SESSION_CACHE_TTL_MS;

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('reloads as soon as the revocation invalidates the entry', async () => {
    let active = true;
    const load = jest.fn(async () => active);

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(true);

    active = false;
    invalidateDeviceSession(SESSION_ID);

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('never serves one user the cached answer for another user', async () => {
    const load = jest.fn(async () => true);

    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(true);
    expect(await isDeviceSessionActive(SESSION_ID, 'user_b', load)).toBe(true);

    expect(load).toHaveBeenCalledTimes(2);
  });

  test('does not cache a failed load', async () => {
    const load = jest
      .fn<Promise<boolean>, []>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(true);

    await expect(isDeviceSessionActive(SESSION_ID, USER_ID, load)).rejects.toThrow(
      'database unavailable'
    );
    expect(await isDeviceSessionActive(SESSION_ID, USER_ID, load)).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('shares one load between concurrent lookups of the same session', async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const load = jest.fn(() => promise);

    const first = isDeviceSessionActive(SESSION_ID, USER_ID, load);
    const second = isDeviceSessionActive(SESSION_ID, USER_ID, load);
    resolve(true);

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
