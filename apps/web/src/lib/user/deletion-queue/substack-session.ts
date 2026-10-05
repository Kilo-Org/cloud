import {
  USER_DELETION_SUBSTACK_TIMEOUT_MS,
  USER_DELETION_SUBSTACK_USER_AGENT,
} from '@/lib/user/deletion-queue/deletion-constants';
import { generateTotpCode, normalizeTotpSecret } from '@/lib/user/deletion-queue/substack-totp';

const REAUTH_START_PATH = '/api/v1/reauthenticate/start';
const REAUTH_COMPLETE_PATH = '/api/v1/reauthenticate/complete';

export type SubstackReauthFailure =
  | { kind: 'low_time' }
  | { kind: 'fetch_failed'; errorCode: 'timeout' | 'network_error' | 'redirect' }
  | { kind: 'http'; status: number }
  | { kind: 'method_unsupported' }
  | { kind: 'error_payload' }
  | { kind: 'incomplete' }
  | { kind: 'invalid_totp_secret' };

export type SubstackReauthResult =
  | { ok: true; cookie: string; cookieChanged: boolean; method: 'totp' }
  | { ok: false; cookie: string; cookieChanged: boolean; failure: SubstackReauthFailure };

export function parseCookieHeader(cookie: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const segment of cookie.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!name || !value) continue;
    jar.set(name, value);
  }
  return jar;
}

export function serializeCookieJar(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function applyResponseCookies(cookie: string, response: Response): string {
  const jar = parseCookieHeader(cookie);
  const changed = applySetCookies(jar, responseSetCookies(response), Date.now());
  return changed ? serializeCookieJar(jar) : cookie;
}

export async function reauthenticateSubstackSession(params: {
  publication: string;
  cookie: string;
  totpSecret: string;
  guard?: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}): Promise<SubstackReauthResult> {
  const timeoutMs = params.timeoutMs ?? USER_DELETION_SUBSTACK_TIMEOUT_MS;
  const originalCookie = params.cookie;
  let cookie = params.cookie;

  const failure = (reason: SubstackReauthFailure): SubstackReauthResult => ({
    ok: false,
    cookie,
    cookieChanged: cookie !== originalCookie,
    failure: reason,
  });

  if (normalizeTotpSecret(params.totpSecret) === null) {
    return failure({ kind: 'invalid_totp_secret' });
  }

  if (params.guard && !params.guard()) return failure({ kind: 'low_time' });

  const headers = () => ({
    Cookie: cookie,
    Accept: 'application/json',
    'User-Agent': USER_DELETION_SUBSTACK_USER_AGENT,
  });

  const start = await reauthFetch(
    `${params.publication}${REAUTH_START_PATH}`,
    { method: 'POST', headers: headers() },
    params.signal,
    timeoutMs
  );
  if (start.response) cookie = applyResponseCookies(cookie, start.response);
  if (start.kind === 'error') return failure({ kind: 'fetch_failed', errorCode: start.errorCode });
  if (!isSuccessStatus(start.response.status)) {
    return failure({ kind: 'http', status: start.response.status });
  }

  if (!isRecord(start.payload) || start.payload.method !== 'totp') {
    return failure({ kind: 'method_unsupported' });
  }

  if (params.guard && !params.guard()) return failure({ kind: 'low_time' });

  const code = generateTotpCode(params.totpSecret, params.now?.() ?? Date.now());
  if (!code) return failure({ kind: 'invalid_totp_secret' });

  const complete = await reauthFetch(
    `${params.publication}${REAUTH_COMPLETE_PATH}`,
    {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    },
    params.signal,
    timeoutMs
  );
  if (complete.response) cookie = applyResponseCookies(cookie, complete.response);
  if (complete.kind === 'error') {
    return failure({ kind: 'fetch_failed', errorCode: complete.errorCode });
  }
  if (!isSuccessStatus(complete.response.status)) {
    return failure({ kind: 'http', status: complete.response.status });
  }

  if (!isRecord(complete.payload)) return failure({ kind: 'incomplete' });
  if ('error' in complete.payload) return failure({ kind: 'error_payload' });
  if (complete.payload.success === false) return failure({ kind: 'error_payload' });
  if (Array.isArray(complete.payload.errors) && complete.payload.errors.length > 0) {
    return failure({ kind: 'error_payload' });
  }

  return { ok: true, cookie, cookieChanged: cookie !== originalCookie, method: 'totp' };
}

type ReauthFetchOutcome =
  | { kind: 'response'; response: Response; payload: unknown }
  | { kind: 'error'; errorCode: 'timeout' | 'network_error' | 'redirect'; response?: Response };

async function reauthFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<ReauthFetchOutcome> {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any(signals),
    });
    if (!isSuccessStatus(response.status)) {
      return { kind: 'response', response, payload: undefined };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (!isRecord(error) || error.name !== 'SyntaxError') {
        return { kind: 'error', errorCode: classifyReauthFetchError(error), response };
      }
      payload = undefined;
    }
    return { kind: 'response', response, payload };
  } catch (error) {
    return { kind: 'error', errorCode: classifyReauthFetchError(error) };
  }
}

function classifyReauthFetchError(error: unknown): 'timeout' | 'network_error' | 'redirect' {
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  const message = error instanceof Error ? error.message : '';
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  if (/redirect/i.test(message) || /redirect/i.test(cause)) return 'redirect';
  if (/timeout/i.test(message)) return 'timeout';
  return 'network_error';
}

function applySetCookies(
  jar: Map<string, string>,
  setCookies: readonly string[],
  now: number
): boolean {
  let changed = false;
  for (const raw of setCookies) {
    const parsed = parseSetCookie(raw, now);
    if (!parsed) continue;
    if (parsed.remove) {
      if (jar.delete(parsed.name)) changed = true;
      continue;
    }
    if (jar.get(parsed.name) !== parsed.value) {
      jar.set(parsed.name, parsed.value);
      changed = true;
    }
  }
  return changed;
}

function parseSetCookie(
  raw: string,
  now: number
): { name: string; value: string; remove: boolean } | null {
  const segments = raw.split(';');
  const pair = segments[0] ?? '';
  const separator = pair.indexOf('=');
  if (separator <= 0) return null;
  const name = pair.slice(0, separator).trim();
  const value = pair.slice(separator + 1).trim();
  if (!name) return null;

  let remove = value === '';
  for (const segment of segments.slice(1)) {
    const trimmed = segment.trim();
    const attributeSeparator = trimmed.indexOf('=');
    const attributeName = (
      attributeSeparator === -1 ? trimmed : trimmed.slice(0, attributeSeparator)
    )
      .trim()
      .toLowerCase();
    const attributeValue =
      attributeSeparator === -1 ? '' : trimmed.slice(attributeSeparator + 1).trim();
    if (attributeName === 'max-age') {
      const seconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(seconds) && seconds <= 0) remove = true;
    } else if (attributeName === 'expires') {
      const expires = Date.parse(attributeValue);
      if (!Number.isNaN(expires) && expires <= now) remove = true;
    }
  }
  return { name, value, remove };
}

function responseSetCookies(response: Response): string[] {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
