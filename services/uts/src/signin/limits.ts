import { jsonResponse } from '../responses';
import { anonymousWriter } from './network';

/**
 * The limit on anonymous sign-in writes (design 3, "Anonymous sign-in writes"): a passkey sign-in
 * challenge, a device authorization, and a provider, SSO or email sign-in start each store a row
 * (the email start also sends mail) before anyone is signed in, and so does a third-party client
 * metadata fetch of GET /authorize (an outbound fetch, then a client row). Each isolate allows one
 * anonymous writer (`anonymousWriter`: an IPv4 address or an IPv6 /48) a number of such writes per
 * minute, counted before the statement or fetch runs: 10 shared by every sign-in write but the SSO
 * start; 60 SSO starts in their own window, because the staff of an org that requires SSO often
 * share one egress address; and 10 metadata fetches in their own window, so client lookups never
 * use up a sign-in. The count is plain data in the isolate, like the PAT miss limit: a caller
 * spread over many isolates gets more, which the rows' short lives, the store's per-writer cap on
 * pending device codes and the pruning of unconsented clients
 * (`uts.maintain_third_party_client_rows`) bound.
 */
const ALLOWANCES = { shared: 10, sso: 60, client_metadata: 10 } as const;
const WINDOW_MS = 60_000;
/** The map holds at most this many windows; past it, the oldest window is dropped first. */
const MAX_WRITERS = 10_000;

type Window = { startedAt: number; count: number };
const windows = new Map<string, Window>();

export type AnonymousWrite =
  | 'passkey_sign_in_challenge'
  | 'device_authorization'
  | 'provider_sign_in_start'
  | 'sso_sign_in_start'
  | 'email_sign_in_start'
  | 'client_metadata_fetch';

/**
 * Null when the writer of `address` may write now (and counts the write); otherwise the seconds
 * until its window ends, logged as an auth action that stored nothing. Requests without a
 * connecting address share one window.
 */
export function anonymousWriteRetryAfter(
  address: string | null,
  action: AnonymousWrite,
  now = Date.now()
): number | null {
  const allowance =
    action === 'sso_sign_in_start'
      ? 'sso'
      : action === 'client_metadata_fetch'
        ? 'client_metadata'
        : 'shared';
  const key = `${allowance}:${anonymousWriter(address) ?? 'unknown'}`;
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
  if (current.count < ALLOWANCES[allowance]) {
    current.count += 1;
    return null;
  }
  console.log(
    JSON.stringify({ event: 'auth_action', action, outcome: 'rate_limited', stored: false })
  );
  return Math.max(1, Math.ceil((current.startedAt + WINDOW_MS - now) / 1000));
}

/** `anonymousWriteRetryAfter` for the JSON calls: null, or the 429 to answer. */
export function anonymousWriteRefusal(
  address: string | null,
  action: AnonymousWrite,
  now = Date.now()
): Response | null {
  const retryAfter = anonymousWriteRetryAfter(address, action, now);
  if (retryAfter === null) return null;
  return jsonResponse({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) });
}
