import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_STORAGE_KEY,
  DEFAULT_KILO_API_BASE_URL,
  DEFAULT_LOCAL_KILO_API_BASE_URL,
  clearStoredSession,
  clearStoredAuth,
  createDeviceAuthRequest,
  getKiloApiBaseUrl,
  loadStoredAuth,
  normalizeStoredAuth,
  pollDeviceAuthCode,
  saveStoredAuth,
  validateAuthToken,
} from './auth';
import type { AuthStorageArea, FetchLike } from './auth';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, {
    ...init,
  });

const createStorage = (initialValue?: unknown): AuthStorageArea & { value: unknown } => {
  let storedValue = initialValue;

  return {
    getItem: key => {
      expect(key).toBe(AUTH_STORAGE_KEY);
      return storedValue;
    },
    removeItem: key => {
      expect(key).toBe(AUTH_STORAGE_KEY);
      storedValue = undefined;
    },
    setItem: (key, value) => {
      expect(key).toBe(AUTH_STORAGE_KEY);
      storedValue = value;
    },
    get value() {
      return storedValue;
    },
  };
};

const createSessionStorage = (): {
  readonly clearCalls: string[];
  readonly storage: Parameters<typeof clearStoredSession>[0];
} => {
  const clearCalls: string[] = [];

  return {
    clearCalls,
    storage: {
      clear: base => {
        clearCalls.push(base);
      },
    },
  };
};

const withStubbedEnv = (env: Record<string, string>, assertion: () => void): void => {
  vi.unstubAllEnvs();

  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }

  try {
    assertion();
  } finally {
    vi.unstubAllEnvs();
  }
};

describe('extension auth configuration', () => {
  it('defaults local extension development to the local web backend', () => {
    withStubbedEnv({ COMMAND: 'serve' }, () => {
      expect(getKiloApiBaseUrl()).toBe(DEFAULT_LOCAL_KILO_API_BASE_URL);
    });
  });

  it('defaults production builds to the hosted backend', () => {
    withStubbedEnv({ COMMAND: 'build' }, () => {
      expect(getKiloApiBaseUrl()).toBe(DEFAULT_KILO_API_BASE_URL);
    });
  });

  it('lets an explicit backend URL override the build-mode default', () => {
    withStubbedEnv({ COMMAND: 'serve', VITE_KILO_API_BASE_URL: ' http://localhost:3001/ ' }, () => {
      expect(getKiloApiBaseUrl()).toBe('http://localhost:3001');
    });
  });
});

describe('extension auth storage', () => {
  it('normalizes valid stored auth and rejects malformed values', () => {
    expect(normalizeStoredAuth({ token: 'token-1', userEmail: 'user@kilo.ai' })).toStrictEqual({
      token: 'token-1',
      userEmail: 'user@kilo.ai',
    });
    expect(normalizeStoredAuth({ token: 'token-1' })).toStrictEqual({
      token: 'token-1',
      userEmail: undefined,
    });
    expect(normalizeStoredAuth({ token: '', userEmail: 'user@kilo.ai' })).toBeUndefined();
    expect(normalizeStoredAuth({ userEmail: 'user@kilo.ai' })).toBeUndefined();
  });

  it('loads, saves, and clears auth through the configured storage key', async () => {
    const storage = createStorage({ token: 'token-1', userEmail: 'user@kilo.ai' });

    await expect(loadStoredAuth(storage)).resolves.toStrictEqual({
      token: 'token-1',
      userEmail: 'user@kilo.ai',
    });

    await saveStoredAuth(storage, { token: 'token-2', userEmail: undefined });
    expect(storage.value).toStrictEqual({ token: 'token-2', userEmail: undefined });

    await clearStoredAuth(storage);
    expect(storage.value).toBeUndefined();
  });

  it('clears all local extension storage for explicit logout', async () => {
    const { clearCalls, storage } = createSessionStorage();

    await clearStoredSession(storage);

    expect(clearCalls).toStrictEqual(['local']);
  });
});

describe('device auth API client', () => {
  it('creates a device auth request using app mode', async () => {
    const seenRequests: string[] = [];
    const fetch: FetchLike = input => {
      seenRequests.push(String(input));
      return jsonResponse(
        {
          code: 'ABCD-2345',
          verificationUrl: 'https://app.kilo.ai/device-auth?code=ABCD-2345&app=1',
        },
        { status: 200 }
      );
    };

    await expect(
      createDeviceAuthRequest({ apiBaseUrl: 'https://app.kilo.ai/', fetch })
    ).resolves.toStrictEqual({
      code: 'ABCD-2345',
      verificationUrl: 'https://app.kilo.ai/device-auth?code=ABCD-2345&app=1',
    });
    expect(seenRequests).toStrictEqual(['https://app.kilo.ai/api/device-auth/codes?app=1']);
  });

  it('maps poll status codes to pending, approved, denied, and expired states', async () => {
    const pollWithResponse = (response: Response) =>
      pollDeviceAuthCode({
        apiBaseUrl: 'https://app.kilo.ai',
        code: 'ABCD-2345',
        fetch: () => response,
      });

    await expect(
      pollWithResponse(jsonResponse({ status: 'pending' }, { status: 202 }))
    ).resolves.toStrictEqual({ status: 'pending' });
    await expect(
      pollWithResponse(
        jsonResponse({ status: 'approved', token: 'token-1', userEmail: 'user@kilo.ai' })
      )
    ).resolves.toStrictEqual({
      auth: { token: 'token-1', userEmail: 'user@kilo.ai' },
      status: 'approved',
    });
    await expect(
      pollWithResponse(jsonResponse({ status: 'denied' }, { status: 403 }))
    ).resolves.toStrictEqual({ status: 'denied' });
    await expect(
      pollWithResponse(jsonResponse({ status: 'expired' }, { status: 410 }))
    ).resolves.toStrictEqual({ status: 'expired' });
  });

  it('validates stored tokens with the user endpoint', async () => {
    const seenHeaders: string[] = [];
    const fetch: FetchLike = (_input, init) => {
      seenHeaders.push(String(new Headers(init?.headers).get('authorization')));
      return jsonResponse({ google_user_email: 'user@kilo.ai' });
    };

    await expect(
      validateAuthToken({ apiBaseUrl: 'https://app.kilo.ai', fetch, token: 'token-1' })
    ).resolves.toStrictEqual({
      auth: { token: 'token-1', userEmail: 'user@kilo.ai' },
      status: 'valid',
    });
    expect(seenHeaders).toStrictEqual(['Bearer token-1']);
  });

  it('returns invalid for rejected tokens and error for failed validation checks', async () => {
    await expect(
      validateAuthToken({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch: () => jsonResponse({ error: 'Unauthorized' }, { status: 401 }),
        token: 'bad-token',
      })
    ).resolves.toStrictEqual({ status: 'invalid' });

    await expect(
      validateAuthToken({
        apiBaseUrl: 'https://app.kilo.ai',
        fetch: () => jsonResponse({ error: 'Server error' }, { status: 500 }),
        token: 'token-1',
      })
    ).resolves.toStrictEqual({ status: 'error' });
  });
});
