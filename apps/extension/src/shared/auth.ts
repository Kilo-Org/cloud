import { z } from 'zod';
import { BROWSER_EXECUTION_SAFETY_KEY } from '../../entrypoints/sidepanel/browser-execution-lock';

export const AUTH_STORAGE_KEY = 'local:kiloAuth';
// Keep credentials separate from a8's execution record, whose writer owns its complete format.
export const BROWSER_PROVIDER_IDENTITY_KEY = 'local:kiloBrowserProviderIdentity';
export const DEFAULT_KILO_API_BASE_URL = 'https://app.kilo.ai';
export const DEFAULT_LOCAL_KILO_API_BASE_URL = 'http://localhost:3000';

export interface StoredAuth {
  readonly token: string;
  readonly userEmail: string | undefined;
}

type MaybePromise<Value> = Promise<Value> | Value;

export interface AuthStorageArea extends Partial<SessionStorageArea> {
  getItem(key: typeof AUTH_STORAGE_KEY): MaybePromise<unknown>;
  removeItem(key: typeof AUTH_STORAGE_KEY): MaybePromise<void>;
  setItem(key: typeof AUTH_STORAGE_KEY, value: StoredAuth): MaybePromise<void>;
}
export interface SessionStorageArea {
  snapshot(base: 'local'): MaybePromise<Record<string, unknown>>;
  removeItems(keys: `local:${string}`[]): MaybePromise<void>;
}

// eslint-disable-next-line promise/prefer-await-to-then -- The resolved promise seeds the serialized write queue.
let profileWrites = Promise.resolve();
/** Serialize account writes with auth cleanup, including across panels when native locks exist. */
export const withBrowserProfileStorageLock = <Result>(
  work: () => Promise<Result>
): Promise<Result> => {
  const previous = profileWrites;
  const result = (async () => {
    await previous;
    const locks = globalThis.navigator?.locks;
    return locks === undefined ? work() : locks.request('kilo:browser-profile-storage', work);
  })();
  // A failed write must reject its caller without poisoning later cleanup or recovery.
  profileWrites = (async () => {
    try {
      await result;
    } catch {
      // The returned result still rejects; only the queue barrier absorbs the failure.
    }
  })();
  return result;
};

const protectedProfileKeys = new Set(
  [BROWSER_EXECUTION_SAFETY_KEY, BROWSER_PROVIDER_IDENTITY_KEY].flatMap(key => [
    key.slice(6),
    `${key.slice(6)}$`,
  ])
);
const removeAccountStorage = async (storageArea: SessionStorageArea): Promise<void> => {
  const keys = Object.keys(await storageArea.snapshot('local'))
    .filter(key => !protectedProfileKeys.has(key))
    .map<`local:${string}`>(key => `local:${key}`);
  // Never clear and restore: a concurrent quarantine write must remain intact throughout logout.
  await storageArea.removeItems(keys);
};

export type FetchLike = (input: string, init?: RequestInit) => MaybePromise<Response>;

export interface DeviceAuthRequest {
  readonly code: string;
  readonly verificationUrl: string;
}

export type DeviceAuthPollResult =
  | {
      readonly status: 'approved';
      readonly auth: StoredAuth;
    }
  | {
      readonly status: 'denied' | 'expired' | 'pending';
    };

export type TokenValidationResult =
  | {
      readonly status: 'valid';
      readonly auth: StoredAuth;
    }
  | {
      readonly status: 'error' | 'invalid';
    };

interface ApiClientOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
}

interface PollDeviceAuthCodeOptions extends ApiClientOptions {
  readonly code: string;
  readonly signal?: AbortSignal;
}

interface ValidateAuthTokenOptions extends ApiClientOptions {
  readonly token: string;
  readonly signal?: AbortSignal;
}

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const nonEmptyStringSchema = z.string().min(1);
const storedAuthSchema = z.object({
  token: nonEmptyStringSchema,
  userEmail: nonEmptyStringSchema.optional(),
});
const deviceAuthRequestSchema = z.object({
  code: nonEmptyStringSchema,
  verificationUrl: nonEmptyStringSchema,
});
const userResponseSchema = z.object({
  google_user_email: nonEmptyStringSchema.optional(),
});

export const getKiloApiBaseUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_KILO_API_BASE_URL;

  if (configuredUrl !== undefined && configuredUrl.trim().length > 0) {
    return trimTrailingSlash(configuredUrl.trim());
  }

  if (import.meta.env.COMMAND === 'serve') {
    return DEFAULT_LOCAL_KILO_API_BASE_URL;
  }

  return DEFAULT_KILO_API_BASE_URL;
};

export const normalizeStoredAuth = (value: unknown): StoredAuth | undefined => {
  const parsed = storedAuthSchema.safeParse(value);

  return parsed.success
    ? { token: parsed.data.token, userEmail: parsed.data.userEmail }
    : undefined;
};

export const loadStoredAuth = async (
  storageArea: AuthStorageArea
): Promise<StoredAuth | undefined> =>
  normalizeStoredAuth(await storageArea.getItem(AUTH_STORAGE_KEY));

export const saveStoredAuth = (storageArea: AuthStorageArea, auth: StoredAuth): Promise<void> =>
  withBrowserProfileStorageLock(async () => {
    const previous = await loadStoredAuth(storageArea);
    const changedAccount =
      previous !== undefined &&
      (previous.userEmail !== undefined && auth.userEmail !== undefined
        ? previous.userEmail !== auth.userEmail
        : previous.token !== auth.token);
    if (changedAccount) {
      const { snapshot, removeItems } = storageArea;
      // Legacy auth-only adapters can save initial auth, but cannot safely switch accounts.
      // Remove this compatibility branch when all auth-only adapters retire.
      if (snapshot === undefined || removeItems === undefined) {
        throw new Error('Account cleanup is unavailable. Sign out before changing accounts.');
      }
      await removeAccountStorage({
        removeItems: keys => removeItems.call(storageArea, keys),
        snapshot: base => snapshot.call(storageArea, base),
      });
    }
    await storageArea.setItem(AUTH_STORAGE_KEY, auth);
  });

export const clearStoredAuth = (storageArea: AuthStorageArea): Promise<void> =>
  withBrowserProfileStorageLock(async () => {
    await storageArea.removeItem(AUTH_STORAGE_KEY);
  });

export const clearStoredSession = (storageArea: SessionStorageArea): Promise<void> =>
  withBrowserProfileStorageLock(() => removeAccountStorage(storageArea));

const parseDeviceAuthRequest = (value: unknown): DeviceAuthRequest => {
  const parsed = deviceAuthRequestSchema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError('Device auth response did not include a code and verification URL.');
  }

  return parsed.data;
};

const parseApprovedAuth = (value: unknown): StoredAuth => {
  const parsed = storedAuthSchema.safeParse(value);

  if (!parsed.success) {
    throw new TypeError('Device auth poll response did not include a token.');
  }

  return {
    token: parsed.data.token,
    userEmail: parsed.data.userEmail,
  };
};

export const createDeviceAuthRequest = async ({
  apiBaseUrl,
  fetch,
}: ApiClientOptions): Promise<DeviceAuthRequest> => {
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/device-auth/codes?app=1`, {
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error('Failed to start sign in.');
  }

  const data: unknown = await response.json();
  return parseDeviceAuthRequest(data);
};

export const pollDeviceAuthCode = async ({
  apiBaseUrl,
  code,
  fetch,
  signal,
}: PollDeviceAuthCodeOptions): Promise<DeviceAuthPollResult> => {
  const requestInit: RequestInit = signal === undefined ? {} : { signal };
  const response = await fetch(
    `${trimTrailingSlash(apiBaseUrl)}/api/device-auth/codes/${encodeURIComponent(code)}`,
    requestInit
  );

  switch (response.status) {
    case 200: {
      const data: unknown = await response.json();
      return { auth: parseApprovedAuth(data), status: 'approved' };
    }
    case 202: {
      return { status: 'pending' };
    }
    case 403: {
      return { status: 'denied' };
    }
    case 410: {
      return { status: 'expired' };
    }
    default: {
      throw new Error('Failed to check sign-in status.');
    }
  }
};

export const validateAuthToken = async ({
  apiBaseUrl,
  fetch,
  signal,
  token,
}: ValidateAuthTokenOptions): Promise<TokenValidationResult> => {
  const requestInit: RequestInit = {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal === undefined ? {} : { signal }),
  };
  const response = await fetch(`${trimTrailingSlash(apiBaseUrl)}/api/user`, requestInit);

  if (response.status === 401 || response.status === 403) {
    return { status: 'invalid' };
  }

  if (!response.ok) {
    return { status: 'error' };
  }

  const data: unknown = await response.json();
  const parsed = userResponseSchema.safeParse(data);

  if (!parsed.success) {
    return { auth: { token, userEmail: undefined }, status: 'valid' };
  }

  return {
    auth: {
      token,
      userEmail: parsed.data.google_user_email,
    },
    status: 'valid',
  };
};
