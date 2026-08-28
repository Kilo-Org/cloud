import { type Href } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import { type NavigationState, type PartialState } from 'expo-router/build/react-navigation/native';

type DevSessionCredentials = {
  token: string;
  refreshToken: string;
  expiresIn: number;
};

const TOKEN_PARAM = 'dev_session_token';
const REFRESH_PARAM = 'dev_session_refresh';
const EXPIRES_PARAM = 'dev_session_expires_in';

type DevSessionRequest = {
  id: number;
  credentials: DevSessionCredentials;
  href: string;
};

export type DevSessionReplacement = {
  request: DevSessionRequest;
  phase: 'teardown' | 'login' | 'sign-in' | 'admitted' | 'enqueued' | 'blocked';
  epoch: number | null;
  userId: string | null;
};

type DevSessionSnapshot = {
  pending: DevSessionRequest | null;
  replacement: DevSessionReplacement | null;
  loginReady: boolean;
};

export const DEV_SESSION_MARKER = '__dev_session_request';
let sequence = 0;
let coldRequest: DevSessionRequest | null = null;
let snapshot: DevSessionSnapshot = { pending: null, replacement: null, loginReady: false };
const listeners = new Set<() => void>();

function publish(next: DevSessionSnapshot): void {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getDevSessionSnapshot(): DevSessionSnapshot {
  return snapshot;
}

export function setDevSessionReplacement(replacement: DevSessionReplacement | null): void {
  publish({ ...snapshot, replacement });
}

export function setDevSessionLoginReady(loginReady: boolean): void {
  publish({ ...snapshot, loginReady });
}

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

export function takeDevSessionFromUrl(
  raw: string,
  href: string | null = null,
  initial = false
): boolean {
  const credentials = parseDevSessionQuery(raw);
  if (!credentials) {
    return false;
  }
  // Legacy credential-only URLs keep the existing default: the Home tab.
  const destination = href ?? '/(app)/(tabs)/(0_home)';
  if (
    initial &&
    coldRequest?.href === destination &&
    coldRequest.credentials.token === credentials.token &&
    coldRequest.credentials.refreshToken === credentials.refreshToken &&
    coldRequest.credentials.expiresIn === credentials.expiresIn
  ) {
    return true;
  }
  sequence += 1;
  const request = { id: sequence, credentials, href: destination };
  if (initial) {
    coldRequest = request;
  }
  // Only the latest waiting request survives; the replacement keeps its own pair.
  publish({ ...snapshot, pending: request });
  return true;
}

export function consumePendingDevSession(): DevSessionRequest | null {
  const request = snapshot.pending;
  if (request) {
    publish({ ...snapshot, pending: null });
  }
  return request;
}

/** Match selected, fully committed routes, not pathname (both tab roots are '/'). */
export function isDevSessionDestinationCommitted(
  state: NavigationState | PartialState<NavigationState> | undefined,
  request: DevSessionRequest
): boolean {
  let selected = state;
  let path = '';
  while (selected) {
    if (selected.index === undefined || selected.stale !== false) {
      return false;
    }
    const route = selected.routes[selected.index];
    if (!route) {
      return false;
    }
    // Expo owns dynamic parameter encoding. Keep group names to distinguish tabs.
    const href = { pathname: route.name, params: route.params };
    path += `/${resolveHref(href as Href).split('?')[0]}`;
    if (!route.state) {
      return (
        !route.name.endsWith(')') &&
        route.params != null &&
        !('screen' in route.params) &&
        DEV_SESSION_MARKER in route.params &&
        route.params[DEV_SESSION_MARKER] === String(request.id) &&
        path.replace(/\/index$/, '') === request.href
      );
    }
    selected = route.state;
  }
  return false;
}

export function subscribePendingDevSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function _resetDevSessionInjectForTests(): void {
  snapshot = { pending: null, replacement: null, loginReady: false };
  sequence = 0;
  coldRequest = null;
  listeners.clear();
}
