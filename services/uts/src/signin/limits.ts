import { jsonResponse } from '../responses';
import { anonymousWriter } from './network';

/**
 * The limit on anonymous sign-in writes (design 3, "Anonymous sign-in writes"): a passkey sign-in
 * challenge, a device authorization, and a provider, SSO or email sign-in start each store a row
 * (the email start also sends mail) before anyone is signed in. Each isolate
 * allows one anonymous writer (`anonymousWriter`: an IPv4 address or an IPv6 /48) `PER_MINUTE`
 * such writes per minute, counted before the statement runs. The count is plain data in the
 * isolate, like the PAT miss limit: a caller spread over many isolates gets more, which the rows'
 * short lives and the store's per-writer cap on pending device codes bound.
 */
const PER_MINUTE = 10;
const WINDOW_MS = 60_000;
/** The map holds at most this many writers; past it, the oldest window is dropped first. */
const MAX_WRITERS = 10_000;

type Window = { startedAt: number; count: number };
const windows = new Map<string, Window>();

export type AnonymousWrite =
  | 'passkey_sign_in_challenge'
  | 'device_authorization'
  | 'provider_sign_in_start'
  | 'sso_sign_in_start'
  | 'email_sign_in_start';

/**
 * Null when the writer of `address` may write now (and counts the write); otherwise the 429 to
 * answer, logged as an auth action that stored nothing. Requests without a connecting address
 * share one window.
 */
export function anonymousWriteRefusal(
  address: string | null,
  action: AnonymousWrite,
  now = Date.now()
): Response | null {
  const key = anonymousWriter(address) ?? 'unknown';
  const current = windows.get(key);
  if (current === undefined || now - current.startedAt >= WINDOW_MS) {
    windows.delete(key);
    if (windows.size >= MAX_WRITERS) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    windows.set(key, { startedAt: now, count: 1 });
    return null;
  }
  if (current.count < PER_MINUTE) {
    current.count += 1;
    return null;
  }
  const retryAfter = Math.max(1, Math.ceil((current.startedAt + WINDOW_MS - now) / 1000));
  console.log(
    JSON.stringify({ event: 'auth_action', action, outcome: 'rate_limited', stored: false })
  );
  return jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) });
}
