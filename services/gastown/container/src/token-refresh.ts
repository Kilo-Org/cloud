/**
 * Container-side helpers for self-refreshing the container JWT.
 *
 * Two use cases:
 *  1. Boot-time: when bootHydration runs, check whether the token is
 *     near expiry. If so, mint a fresh one before using it.
 *  2. Reactive: when a call to the worker 401s, mint a fresh token
 *     and retry once.
 */

import { log } from './logger';

const MANAGER_LOG = '[token-refresh]';

/**
 * Return the number of milliseconds until the JWT `exp` claim.
 * Returns `null` if the token is malformed or has no `exp`.
 *
 * This does NOT verify the token — it only reads the claim.
 */
export function msUntilTokenExpiry(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    // Base64-URL decode. Bun / modern runtimes support atob directly,
    // but jwt uses URL-safe encoding, so we need to normalise first.
    const normalised = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
    const decoded = atob(padded);
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object') return null;
    const exp = (parsed as { exp?: unknown }).exp;
    if (typeof exp !== 'number') return null;
    return exp * 1000 - Date.now();
  } catch {
    return null;
  }
}

/**
 * Call the worker's `/refresh-container-token` endpoint to mint a
 * fresh container JWT. The current token (possibly expired, but
 * still correctly signed) authenticates the request.
 *
 * On success, updates `process.env.GASTOWN_CONTAINER_TOKEN` and
 * returns the new token. On failure, logs and returns null — the
 * caller decides whether to proceed with the stale token or bail.
 */
export async function fetchFreshContainerToken(): Promise<string | null> {
  const apiUrl = process.env.GASTOWN_API_URL;
  const townId = process.env.GASTOWN_TOWN_ID;
  const currentToken = process.env.GASTOWN_CONTAINER_TOKEN;

  if (!apiUrl || !townId || !currentToken) {
    log.warn('token_refresh.skipped_missing_env', {
      hasApiUrl: !!apiUrl,
      hasTownId: !!townId,
      hasCurrentToken: !!currentToken,
    });
    return null;
  }

  const t0 = Date.now();
  try {
    const resp = await fetch(`${apiUrl}/api/towns/${townId}/refresh-container-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentToken}`,
      },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      log.warn('token_refresh.fetch_failed', {
        status: resp.status,
        durationMs: Date.now() - t0,
        body: text.slice(0, 200),
      });
      return null;
    }
    const body: unknown = await resp.json();
    const token =
      body && typeof body === 'object' && 'data' in body
        ? (body as { data?: { token?: unknown } }).data?.token
        : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      log.warn('token_refresh.invalid_response', { durationMs: Date.now() - t0 });
      return null;
    }
    process.env.GASTOWN_CONTAINER_TOKEN = token;
    log.info('token_refresh.succeeded', { durationMs: Date.now() - t0 });
    return token;
  } catch (err) {
    log.warn('token_refresh.network_error', {
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    });
    return null;
  }
}

/**
 * Boot-time refresh: if the current container token expires within
 * `thresholdMs` (default 30 minutes), proactively mint a fresh one.
 */
export async function refreshTokenIfNearExpiry(thresholdMs = 30 * 60_000): Promise<void> {
  const current = process.env.GASTOWN_CONTAINER_TOKEN;
  if (!current) {
    console.log(`${MANAGER_LOG} no current container token — skipping near-expiry refresh`);
    return;
  }
  const msLeft = msUntilTokenExpiry(current);
  if (msLeft === null) {
    console.log(`${MANAGER_LOG} token has no exp claim — skipping near-expiry refresh`);
    return;
  }
  if (msLeft > thresholdMs) {
    console.log(
      `${MANAGER_LOG} token valid for ${Math.round(msLeft / 60_000)}m — skipping near-expiry refresh`
    );
    return;
  }
  log.info('token_refresh.boot_near_expiry', {
    msUntilExpiry: msLeft,
    thresholdMs,
  });
  await fetchFreshContainerToken();
}
