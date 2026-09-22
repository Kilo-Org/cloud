import 'server-only';

import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { OPENAI_CLIENT_ID, OPENAI_CLIENT_SECRET, BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { OPENAI_RESOURCE, OPENAI_TOKEN_ENDPOINT } from '@/lib/auth/openai/config';
import {
  decryptOpenAiChatGptConnection,
  markOpenAiChatGptConnectionErrored,
  openAiChatGptOwnerWhere,
  openAiChatGptOwnerKey,
  readOpenAiChatGptConnectionRow,
  type OpenAiChatGptDatabase,
  type OpenAiChatGptOwner,
} from './store';
import type { OpenAiChatGptConnection } from './types';

/**
 * Refreshes the delegated OpenAI access token for a "Sign in with ChatGPT"
 * connection. The stored access token is returned unchanged while it has more
 * than `REFRESH_WINDOW_SECONDS` left; otherwise the refresh request runs under
 * a row lock that is held for that one request, so one refresh happens per
 * connection even across concurrent instances, and neither a retry nor its
 * backoff sleep keeps the lock or a pool connection open.
 *
 * Nothing here ever logs, returns or embeds a token or the client secret in an
 * exception message: only the OAuth error code and the user id are logged.
 */

/** Refresh this many seconds before the access token actually expires. */
export const OPENAI_CHATGPT_REFRESH_WINDOW_SECONDS = 60;

/** Total attempts for a retryable refresh failure. */
export const OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS = 3;

/** Base delay for the exponential backoff between retryable attempts. */
export const OPENAI_CHATGPT_REFRESH_INITIAL_BACKOFF_MS = 250;

/**
 * Upper bound on a single retry delay. OpenAI may send `Retry-After` on a
 * throttling response; the delay honors it but stays inside the gateway request
 * budget instead of sleeping for however long the header names.
 */
export const OPENAI_CHATGPT_REFRESH_MAX_BACKOFF_MS = 10_000;

/** Shown when the connection can no longer be refreshed and must be reconnected. */
export const OPENAI_CHATGPT_RECONNECT_MESSAGE =
  'Your ChatGPT connection has expired. Reconnect to continue.';

/**
 * OAuth error codes that mean the stored refresh token can never work again.
 * The credential is dead: `markOpenAiChatGptConnectionErrored` clears the stored OpenAI
 * token set, disables the connection, and the user is told to reconnect.
 */
const TERMINAL_REFRESH_ERROR_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

/** A conflict is a lost race against a sibling refresh; retrying can win. */
const RETRYABLE_REFRESH_ERROR_CODE = 'refresh_token_conflict';

/**
 * The outcome of resolving a usable delegated access token. `terminal` is
 * distinct from `failed`: a terminal outcome means OpenAI has already rejected
 * the stored credential for good (the connection is disabled and cleared), so
 * the caller must not keep serving the request through another billing path.
 * `failed` is a transient refresh failure that leaves the stored credential in
 * place.
 */
export type OpenAiChatGptAccessTokenOutcome =
  | { kind: 'access_token'; accessToken: string }
  | { kind: 'no_connection' }
  | { kind: 'terminal' }
  | { kind: 'failed' };

type RefreshDecision =
  | { kind: 'access_token'; accessToken: string }
  | { kind: 'no_connection' }
  | { kind: 'terminal' }
  | { kind: 'failed' };

/**
 * One locked refresh attempt. `retry` is a retryable failure that the caller
 * backs off from after the lock is released. `retryAfterMs` carries the
 * server's own `Retry-After` delay when the response provided one.
 */
type RefreshAttempt = RefreshDecision | { kind: 'retry'; retryAfterMs?: number };

/**
 * Single-flight per owner within one process: concurrent callers share the same
 * in-flight refresh instead of each issuing their own request.
 */
const inFlightRefreshes = new Map<string, Promise<OpenAiChatGptAccessTokenOutcome>>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function backoffDelayMs(attempt: number): number {
  const exponential = OPENAI_CHATGPT_REFRESH_INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * OPENAI_CHATGPT_REFRESH_INITIAL_BACKOFF_MS);
  return exponential + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function refreshRequestHeaders(): string {
  // OpenAI authenticates the confidential client with HTTP Basic, with both
  // halves form-urlencoded exactly as the spec requires.
  const credentials = `${encodeURIComponent(OPENAI_CLIENT_ID)}:${encodeURIComponent(OPENAI_CLIENT_SECRET)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

/**
 * Posts the refresh grant. `resource` repeats the exact value used in the
 * original authorization request; omitting it returns a token scoped to
 * nothing, which would silently break every OpenAI call.
 */
async function postRefreshRequest(refreshToken: string): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_CLIENT_ID,
    resource: OPENAI_RESOURCE,
  });

  return fetch(OPENAI_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: refreshRequestHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readStringField(source: unknown, field: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Extracts the OAuth `error` code, tolerating both the string and object forms. */
function readOAuthErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  return readStringField(error, 'code');
}

function readExpiresIn(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>).expires_in;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Epoch seconds before which OpenAI asks that the token not be refreshed
 * again. The token response is not typed by the spec, so both an epoch-seconds
 * number and an ISO-8601 string are accepted; an unreadable value is ignored
 * rather than guessed.
 */
function readEarliestRefreshAt(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>).earliest_refresh_at;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
  }
  return undefined;
}

/**
 * `Retry-After` as a delay in milliseconds. Both the delta-seconds and the
 * HTTP-date forms are accepted; a missing or unreadable header is undefined so
 * the caller falls back to its own backoff.
 */
function readRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * True when the stored token can serve a request without refreshing. A token
 * with time left is served while it is fresh, and also while OpenAI's
 * `earliest_refresh_at` says the refresh window has not opened yet. An expired
 * token is never served: it must refresh, whatever `earliest_refresh_at` says.
 */
function isUsableWithoutRefresh(connection: OpenAiChatGptConnection, now: number): boolean {
  if (!connection.access_token || connection.expires_at <= now) return false;
  if (connection.expires_at - now > OPENAI_CHATGPT_REFRESH_WINDOW_SECONDS) return true;
  return connection.earliest_refresh_at !== undefined && now < connection.earliest_refresh_at;
}

/**
 * The delay before the next retry: the exponential backoff, raised to the
 * server's `Retry-After` when it asked for longer, capped so one attempt never
 * sleeps past the gateway request budget.
 */
function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  const honored = Math.min(retryAfterMs ?? 0, OPENAI_CHATGPT_REFRESH_MAX_BACKOFF_MS);
  return Math.max(backoffDelayMs(attempt), honored);
}

/**
 * Logs only the OAuth error code and the owner. The message names no credential
 * and prints no value: a log line is written once and read forever.
 */
function logRefreshFailure(owner: OpenAiChatGptOwner, errorCode: string): void {
  console.error(
    '[openai-chatgpt] refresh failed: %s (%s)',
    errorCode,
    openAiChatGptOwnerKey(owner)
  );
}

function isRetryableRefreshFailure(response: Response, errorCode: string | undefined): boolean {
  if (errorCode === RETRYABLE_REFRESH_ERROR_CODE) return true;
  return response.status === 409 || response.status === 429 || response.status >= 500;
}

/**
 * Runs one refresh request inside the transaction that holds the row lock and
 * persists the rotated pair on success, before the lock is released. A retryable
 * failure returns `retry`: the caller then releases the lock, backs off outside
 * it, and re-reads the row on the next attempt. Holding the lock for exactly one
 * request keeps a backed-off refresh from blocking a sibling instance or a
 * connection-pool slot across the wait.
 */
async function attemptRefresh(
  tx: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner,
  connection: OpenAiChatGptConnection
): Promise<RefreshAttempt> {
  const refreshToken = connection.refresh_token;
  if (!refreshToken) {
    // Without a refresh token there is nothing to rotate; the connection can
    // only be recovered by signing in again.
    return { kind: 'terminal' };
  }

  const response = await postRefreshRequest(refreshToken);
  const body = await readResponseBody(response);

  if (response.ok) {
    const accessToken = readStringField(body, 'access_token');
    const expiresIn = readExpiresIn(body);
    if (accessToken && expiresIn) {
      const earliestRefreshAt = readEarliestRefreshAt(body);
      const updated: OpenAiChatGptConnection = {
        ...connection,
        access_token: accessToken,
        refresh_token: readStringField(body, 'refresh_token') ?? refreshToken,
        expires_at: nowSeconds() + expiresIn,
        ...(earliestRefreshAt !== undefined ? { earliest_refresh_at: earliestRefreshAt } : {}),
        scope: readStringField(body, 'scope') ?? connection.scope,
        token_type: readStringField(body, 'token_type') ?? connection.token_type,
        status: 'connected',
        error_message: undefined,
        error_at: undefined,
      };

      await tx
        .update(openai_chatgpt_connections)
        .set({
          encrypted_connection: encryptApiKey(JSON.stringify(updated), BYOK_ENCRYPTION_KEY),
          is_enabled: true,
        })
        .where(openAiChatGptOwnerWhere(owner));

      return { kind: 'access_token', accessToken };
    }
  }

  const errorCode = readOAuthErrorCode(body) ?? `http_${response.status}`;
  logRefreshFailure(owner, errorCode);

  if (TERMINAL_REFRESH_ERROR_CODES.has(errorCode)) {
    return { kind: 'terminal' };
  }

  if (!isRetryableRefreshFailure(response, errorCode)) {
    return { kind: 'failed' };
  }

  const retryAfterMs = readRetryAfterMs(response);
  return retryAfterMs === undefined ? { kind: 'retry' } : { kind: 'retry', retryAfterMs };
}

/**
 * Re-reads the connection under the row lock so a sibling instance that already
 * refreshed is not refreshed again, then returns the fresh token, decides to
 * refresh, or reports why it cannot. A disabled row is no connection: the row
 * can be disabled by the ordinary BYOK toggle while the payload still says
 * `connected`.
 *
 * A terminal failure is written back inside this same transaction, while the
 * row lock is still held. A reconnect that saves a new row between the rejected
 * token exchange and the write therefore cannot be erased by a stale failure.
 */
async function resolveInsideLock(
  tx: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner
): Promise<RefreshAttempt> {
  const row = await readOpenAiChatGptConnectionRow(tx, owner, { forUpdate: true });
  if (!row || !row.is_enabled) return { kind: 'no_connection' };

  const connection = decryptOpenAiChatGptConnection(row.encrypted_connection);
  if (!connection) return { kind: 'no_connection' };

  if (isUsableWithoutRefresh(connection, nowSeconds())) {
    return { kind: 'access_token', accessToken: connection.access_token };
  }

  const attempt = await attemptRefresh(tx, owner, connection);
  if (attempt.kind === 'terminal') {
    await markOpenAiChatGptConnectionErrored(
      tx,
      owner,
      connection,
      OPENAI_CHATGPT_RECONNECT_MESSAGE
    );
  }
  return attempt;
}

async function resolveOpenAiChatGptAccessTokenUncached(
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptAccessTokenOutcome> {
  try {
    if (!OPENAI_CLIENT_ID || !OPENAI_CLIENT_SECRET) {
      console.error(
        '[openai-chatgpt] refresh failed: missing client configuration (%s)',
        openAiChatGptOwnerKey(owner)
      );
      return { kind: 'failed' };
    }

    // Fast path: no lock, no network call while the stored token can still
    // serve a request. A disabled row is skipped so it can never serve one.
    const row = await readOpenAiChatGptConnectionRow(db, owner);
    const current =
      row?.is_enabled === true ? decryptOpenAiChatGptConnection(row.encrypted_connection) : null;
    if (current && isUsableWithoutRefresh(current, nowSeconds())) {
      return { kind: 'access_token', accessToken: current.access_token };
    }

    for (let attempt = 1; attempt <= OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS; attempt++) {
      // The row lock is held for one refresh request only. The backoff between
      // attempts runs with it released, and each attempt re-reads the row, so a
      // sibling instance that refreshed meanwhile is adopted rather than
      // refreshed over.
      const decision = await db.transaction(tx => resolveInsideLock(tx, owner));

      // A terminal decision has already disabled the row inside that transaction.
      if (decision.kind !== 'retry') return decision;

      if (attempt < OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS) {
        await sleep(retryDelayMs(attempt, decision.retryAfterMs));
      }
    }

    return { kind: 'failed' };
  } catch (error) {
    // A thrown error must never carry a credential: log only its type and the owner.
    console.error(
      '[openai-chatgpt] refresh errored: %s (%s)',
      error instanceof Error ? error.name : 'UnknownError',
      openAiChatGptOwnerKey(owner)
    );
    return { kind: 'failed' };
  }
}

/**
 * Resolves the delegated credential for the owner's ChatGPT connection.
 * Concurrent calls within one process share one refresh. `terminal` means the
 * stored credential can never work again: the connection has been cleared and
 * disabled, and the caller must not fall back to another billing path.
 */
export function resolveOpenAiChatGptAccessToken(
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptAccessTokenOutcome> {
  const key = openAiChatGptOwnerKey(owner);
  const existing = inFlightRefreshes.get(key);
  if (existing) return existing;

  const pending = resolveOpenAiChatGptAccessTokenUncached(owner).finally(() => {
    inFlightRefreshes.delete(key);
  });
  inFlightRefreshes.set(key, pending);
  return pending;
}
