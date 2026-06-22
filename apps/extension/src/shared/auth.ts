export const AUTH_STORAGE_KEY = 'local:kiloAuth';
export const DEFAULT_KILO_API_BASE_URL = 'https://app.kilo.ai';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const getKiloApiBaseUrl = (): string => {
  const configuredUrl = import.meta.env.VITE_KILO_API_BASE_URL;

  if (typeof configuredUrl === 'string' && configuredUrl.trim().length > 0) {
    return trimTrailingSlash(configuredUrl.trim());
  }

  return DEFAULT_KILO_API_BASE_URL;
};

export const normalizeStoredAuth = (value: unknown): StoredAuth | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const token = getOptionalString(value['token']);

  if (token === undefined) {
    return undefined;
  }

  return {
    token,
    userEmail: getOptionalString(value['userEmail']),
  };
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

const parseDeviceAuthRequest = (value: unknown): DeviceAuthRequest => {
  if (!isRecord(value)) {
    throw new TypeError('Device auth response was not an object.');
  }

  const code = getOptionalString(value['code']);
  const verificationUrl = getOptionalString(value['verificationUrl']);

  if (code === undefined || verificationUrl === undefined) {
    throw new TypeError('Device auth response did not include a code and verification URL.');
  }

  return { code, verificationUrl };
};

const parseApprovedAuth = (value: unknown): StoredAuth => {
  if (!isRecord(value)) {
    throw new TypeError('Device auth poll response was not an object.');
  }

  const token = getOptionalString(value['token']);

  if (token === undefined) {
    throw new TypeError('Device auth poll response did not include a token.');
  }

  return {
    token,
    userEmail: getOptionalString(value['userEmail']),
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

  if (!isRecord(data)) {
    return { auth: { token, userEmail: undefined }, status: 'valid' };
  }

  return {
    auth: {
      token,
      userEmail: getOptionalString(data['google_user_email']),
    },
    status: 'valid',
  };
};
