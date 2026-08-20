type DevSessionCredentials = {
  token: string;
  refreshToken: string;
  expiresIn: number;
};

const TOKEN_PARAM = 'dev_session_token';
const REFRESH_PARAM = 'dev_session_refresh';
const EXPIRES_PARAM = 'dev_session_expires_in';

let pending: DevSessionCredentials | null = null;
const listeners = new Set<() => void>();

export function parseDevSessionQuery(raw: string): DevSessionCredentials | null {
  if (!__DEV__) {
    return null;
  }
  if (raw.length === 0) {
    return null;
  }
  const queryStart = raw.indexOf('?');
  if (queryStart === -1) {
    return null;
  }
  let queryEnd = raw.length;
  const hash = raw.indexOf('#', queryStart);
  if (hash !== -1) {
    queryEnd = hash;
  }
  const params = new URLSearchParams(raw.slice(queryStart + 1, queryEnd));
  const token = params.get(TOKEN_PARAM);
  const refreshToken = params.get(REFRESH_PARAM);
  const expiresInRaw = params.get(EXPIRES_PARAM);
  if (!token || !refreshToken || !expiresInRaw) {
    return null;
  }
  const expiresIn = Number(expiresInRaw);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }
  return { token, refreshToken, expiresIn };
}

export function takeDevSessionFromUrl(raw: string): void {
  const credentials = parseDevSessionQuery(raw);
  if (!credentials) {
    return;
  }
  pending = credentials;
  for (const listener of listeners) {
    listener();
  }
}

export function consumePendingDevSession(): DevSessionCredentials | null {
  const credentials = pending;
  pending = null;
  return credentials;
}

export function subscribePendingDevSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetDevSessionInjectForTests(): void {
  pending = null;
  listeners.clear();
}
