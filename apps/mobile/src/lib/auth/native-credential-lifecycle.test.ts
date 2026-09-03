import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_GATEWAY_CREDENTIAL_FORMAT,
  type NativeCredentialBundleMetadata,
  type NativeSessionCredentials,
} from '@kilocode/app-shared/native-auth';
import * as SecureStore from 'expo-secure-store';
import { bumpAuthEpoch } from './auth-epoch';
import {
  getGatewayAuthTokenForRequest,
  performRefresh,
  persistSignInCredentialsAtEpoch,
  setCredentials,
} from './credentials';
import {
  clearActiveToken,
  getActiveToken,
  getAuthTokenForRequest,
  setActiveToken,
  setSignOutTeardownActive,
} from './token-owner';
import {
  AUTH_TOKEN_KEY,
  NATIVE_CREDENTIAL_BUNDLE_KEY,
  REFRESH_TOKEN_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    await Promise.resolve();
    store.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    store.delete(key);
  }),
}));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.test' }));

function bundle(
  suffix: string,
  expiresAt = new Date(Date.now() + 3_600_000).toISOString()
): NativeSessionCredentials & { metadata: NativeCredentialBundleMetadata } {
  return {
    token: `api-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    expiresIn: 3600,
    metadata: {
      credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
      gatewayToken: `gateway-${suffix}`,
      expiresAt,
    },
  };
}

beforeEach(() => {
  store.clear();
  bumpAuthEpoch();
  clearActiveToken();
  setSignOutTeardownActive(false);
  vi.mocked(SecureStore.getItemAsync)
    .mockReset()
    .mockImplementation(async key => {
      await Promise.resolve();
      return store.get(key) ?? null;
    });
  vi.mocked(SecureStore.setItemAsync)
    .mockReset()
    .mockImplementation(async (key, value) => {
      await Promise.resolve();
      store.set(key, value);
    });
  vi.mocked(SecureStore.deleteItemAsync)
    .mockReset()
    .mockImplementation(async key => {
      await Promise.resolve();
      store.delete(key);
    });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native credential bundle lifecycle', () => {
  it('stores the bundle atomically and removes keys an older client could misroute', async () => {
    store.set(AUTH_TOKEN_KEY, 'legacy');
    store.set(REFRESH_TOKEN_KEY, 'legacy-refresh');
    store.set(TOKEN_EXPIRES_AT_KEY, '123');
    const credentials = bundle('one');
    await expect(setCredentials(credentials)).resolves.toBe(true);
    expect(JSON.parse(store.get(NATIVE_CREDENTIAL_BUNDLE_KEY) ?? 'null')).toEqual(credentials);
    expect(store.has(AUTH_TOKEN_KEY)).toBe(false);
    expect(store.has(REFRESH_TOKEN_KEY)).toBe(false);
    expect(store.has(TOKEN_EXPIRES_AT_KEY)).toBe(false);
    clearActiveToken();
    await expect(getAuthTokenForRequest()).resolves.toBe('api-one');
    await expect(getGatewayAuthTokenForRequest()).resolves.toBe('gateway-one');
    expect(getActiveToken()?.expiresAtMs).toBe(Date.parse(credentials.metadata.expiresAt));
  });

  it('rejects an incomplete tagged pair before writing or replacing the owner', async () => {
    setActiveToken('prior-token', null);
    await expect(
      persistSignInCredentialsAtEpoch('api-one', undefined, { bundle: bundle('one').metadata })
    ).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(getActiveToken()?.token).toBe('prior-token');
  });

  it.each([
    'broken-json',
    '{}',
    JSON.stringify({ token: 'misplaced-legacy', refreshToken: 'refresh', expiresIn: 3600 }),
  ])('does not fall back to legacy credentials from a corrupt versioned record: %s', async raw => {
    store.set(NATIVE_CREDENTIAL_BUNDLE_KEY, raw);
    store.set(AUTH_TOKEN_KEY, 'legacy');
    store.set(REFRESH_TOKEN_KEY, 'legacy-refresh');
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    await expect(getAuthTokenForRequest()).resolves.toBeNull();
    await expect(getGatewayAuthTokenForRequest()).resolves.toBeNull();
    await expect(performRefresh()).resolves.toMatchObject({ ok: false, refused: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes both members through one rotation before a gateway request', async () => {
    await setCredentials(bundle('old', new Date(Date.now() + 30_000).toISOString()));
    const next = bundle('new');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(next));
    vi.stubGlobal('fetch', fetchMock);
    const [refresh, gatewayToken] = await Promise.all([
      performRefresh(),
      getGatewayAuthTokenForRequest(),
    ]);
    expect(refresh.ok).toBe(true);
    expect(gatewayToken).toBe('gateway-new');
    await expect(getAuthTokenForRequest()).resolves.toBe('api-new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        refreshToken: 'refresh-old',
        credentialFormat: API_GATEWAY_CREDENTIAL_FORMAT,
      })
    );
    expect(JSON.parse(store.get(NATIVE_CREDENTIAL_BUNDLE_KEY) ?? 'null')).toEqual(next);
  });

  it('replaces a modern bundle with a valid legacy response during rollback', async () => {
    await setCredentials(bundle('old'));
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ token: 'legacy-new', refreshToken: 'legacy-refresh', expiresIn: 3600 })
        )
    );
    await expect(performRefresh()).resolves.toMatchObject({ ok: true, token: 'legacy-new' });
    expect(store.has(NATIVE_CREDENTIAL_BUNDLE_KEY)).toBe(false);
    expect(store.get(AUTH_TOKEN_KEY)).toBe('legacy-new');
    await expect(getGatewayAuthTokenForRequest()).resolves.toBe('legacy-new');
  });

  it('clears partial disk state and the current owner when persistence fails', async () => {
    await setCredentials(bundle('old'));
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      await Promise.resolve();
      store.set(key, value);
      throw new Error('synthetic storage failure');
    });
    await expect(setCredentials(bundle('new'))).rejects.toThrow('synthetic storage failure');
    expect(store.size).toBe(0);
    expect(getActiveToken()).toBeNull();
  });

  it('never returns a different account gateway credential after a cold-read race', async () => {
    const old = bundle('old');
    store.set(NATIVE_CREDENTIAL_BUNDLE_KEY, JSON.stringify(old));
    const gate = Promise.withResolvers<undefined>();
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async () => {
      await gate.promise;
      return JSON.stringify(old);
    });
    const pending = getGatewayAuthTokenForRequest();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(NATIVE_CREDENTIAL_BUNDLE_KEY);
    bumpAuthEpoch();
    const next = bundle('new');
    setActiveToken(next.token, Date.parse(next.metadata.expiresAt), next.metadata);
    gate.resolve(undefined);
    await expect(pending).resolves.toBeNull();
    await expect(getGatewayAuthTokenForRequest()).resolves.toBe('gateway-new');
  });
});
