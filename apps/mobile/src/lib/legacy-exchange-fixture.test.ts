import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';

import { handleLegacyExchangeFixturePath } from './legacy-exchange-fixture';

/**
 * The dev-only legacy-session fixture: the keychain state a pre-token-pair
 * build left behind, which the cold-start exchange branches on. What matters is
 * that the seed writes exactly that state — token present, refresh token,
 * expiry and completion marker absent — so a relaunch runs the real exchange,
 * and that nothing else is touched.
 */

const stored = vi.hoisted(() => ({
  values: new Map<string, string>(),
  writes: [] as { readonly key: string; readonly value: string }[],
  deletes: [] as string[],
}));

// The fixture logs one line when its keychain worker is done, so that line is
// the signal to await instead of a guessed delay.
const logs = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('@/lib/auth/secure-store', () => ({
  setItemAsync: async (key: string, value: string) => {
    await Promise.resolve();
    stored.values.set(key, value);
    stored.writes.push({ key, value });
  },
  deleteItemAsync: async (key: string) => {
    await Promise.resolve();
    stored.values.delete(key);
    stored.deletes.push(key);
  },
}));

/** Await the fixture's own worker, which runs after the call returns. */
async function waitForLog(message: string): Promise<void> {
  await vi.waitFor(() => {
    expect(logs.info).toHaveBeenCalledWith(`[legacy-exchange-fixture] ${message}`);
  });
}

beforeEach(() => {
  stored.values.clear();
  stored.writes.length = 0;
  stored.deletes.length = 0;
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    logs.info(...args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  logs.info.mockReset();
});

describe('handleLegacyExchangeFixturePath', () => {
  it('leaves every other path alone', () => {
    expect(handleLegacyExchangeFixturePath('/dev/home-fixture/connection-lost')).toBe(false);
    expect(handleLegacyExchangeFixturePath('/dev/legacy-exchange-fixture')).toBe(false);
    expect(handleLegacyExchangeFixturePath('/sign-in')).toBe(false);
    expect(stored.writes).toEqual([]);
    expect(stored.deletes).toEqual([]);
  });

  it('seeds the legacy session from the token, dropping the completed-session keys', async () => {
    stored.values.set(REFRESH_TOKEN_KEY, 'refresh');
    stored.values.set(TOKEN_EXPIRES_AT_KEY, '1999');
    stored.values.set(LEGACY_EXCHANGE_DONE_KEY, '1');

    expect(handleLegacyExchangeFixturePath('/dev/legacy-exchange-fixture/seed?token=jwt-abc')).toBe(
      true
    );
    await waitForLog('seeded a legacy session; relaunch the app to run the exchange');

    expect(stored.writes).toEqual([{ key: AUTH_TOKEN_KEY, value: 'jwt-abc' }]);
    expect(stored.deletes).toEqual([
      REFRESH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
      LEGACY_EXCHANGE_DONE_KEY,
    ]);
    expect([...stored.values.keys()]).toEqual([AUTH_TOKEN_KEY]);
    expect(stored.values.get(AUTH_TOKEN_KEY)).toBe('jwt-abc');
  });

  it('reads a percent-encoded token from a link that carries a scheme and a fragment', async () => {
    expect(
      handleLegacyExchangeFixturePath(
        'kiloapp:///dev/legacy-exchange-fixture/seed?from=test&token=a%2Bb%3D#anchor'
      )
    ).toBe(true);
    await waitForLog('seeded a legacy session; relaunch the app to run the exchange');

    expect(stored.values.get(AUTH_TOKEN_KEY)).toBe('a+b=');
  });

  it('writes nothing when the link carries no token', async () => {
    expect(handleLegacyExchangeFixturePath('/dev/legacy-exchange-fixture/seed')).toBe(true);
    await waitForLog('seed skipped: no token');

    expect(stored.writes).toEqual([]);
    expect(stored.deletes).toEqual([]);
  });

  it('writes nothing when the token is empty', async () => {
    expect(handleLegacyExchangeFixturePath('/dev/legacy-exchange-fixture/seed?token=')).toBe(true);
    await waitForLog('seed skipped: no token');

    expect(stored.writes).toEqual([]);
    expect(stored.deletes).toEqual([]);
  });

  it('clears the same four keys', async () => {
    stored.values.set(AUTH_TOKEN_KEY, 'jwt-abc');
    stored.values.set(REFRESH_TOKEN_KEY, 'refresh');
    stored.values.set(TOKEN_EXPIRES_AT_KEY, '1999');
    stored.values.set(LEGACY_EXCHANGE_DONE_KEY, '1');

    expect(handleLegacyExchangeFixturePath('/dev/legacy-exchange-fixture/clear')).toBe(true);
    await waitForLog('cleared');

    expect(stored.deletes).toEqual([
      AUTH_TOKEN_KEY,
      REFRESH_TOKEN_KEY,
      TOKEN_EXPIRES_AT_KEY,
      LEGACY_EXCHANGE_DONE_KEY,
    ]);
    expect(stored.values.size).toBe(0);
    expect(stored.writes).toEqual([]);
  });

  it('handles an unknown name without touching the keychain', async () => {
    expect(handleLegacyExchangeFixturePath('/dev/legacy-exchange-fixture/explode')).toBe(true);
    await waitForLog('unknown fixture explode');

    expect(stored.writes).toEqual([]);
    expect(stored.deletes).toEqual([]);
  });
});
