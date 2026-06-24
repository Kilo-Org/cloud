import { z } from 'zod';

export const AUTH_STORAGE_KEY = 'local:kiloAuth';
export const DEFAULT_KILO_API_BASE_URL = 'https://app.kilo.ai';
export const DEFAULT_LOCAL_KILO_API_BASE_URL = 'http://localhost:3000';

export interface StoredAuth {
  readonly token: string;
  readonly userEmail: string | undefined;
}

type MaybePromise<Value> = Promise<Value> | Value;

export interface AuthStorageArea {
  getItem(key: typeof AUTH_STORAGE_KEY): MaybePromise<unknown>;
  removeItem(key: typeof AUTH_STORAGE_KEY): MaybePromise<void>;
  setItem(key: typeof AUTH_STORAGE_KEY, value: StoredAuth): MaybePromise<void>;
}
export interface SessionStorageArea {
  clear(base: 'local'): MaybePromise<void>;
}

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

  if (typeof configuredUrl === 'string' && configuredUrl.trim().length > 0) {
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

export const saveStoredAuth = async (
  storageArea: AuthStorageArea,
  auth: StoredAuth
): Promise<void> => {
  await storageArea.setItem(AUTH_STORAGE_KEY, auth);
};

export const clearStoredAuth = async (storageArea: AuthStorageArea): Promise<void> => {
  await storageArea.removeItem(AUTH_STORAGE_KEY);
};

export const clearStoredSession = async (storageArea: SessionStorageArea): Promise<void> => {
  await storageArea.clear('local');
};

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
