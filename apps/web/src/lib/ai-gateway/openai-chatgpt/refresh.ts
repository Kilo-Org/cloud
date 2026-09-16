import 'server-only';

import { and, eq } from 'drizzle-orm';
import { byok_api_keys } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { encryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { OPENAI_CLIENT_ID, OPENAI_CLIENT_SECRET, BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { OPENAI_RESOURCE, OPENAI_TOKEN_ENDPOINT } from '@/lib/auth/openai/config';
import { OPENAI_CHATGPT_PROVIDER_ID } from './provider-id';
import {
  decryptOpenAiChatGptConnection,
  markOpenAiChatGptError,
  readOpenAiChatGptConnectionRow,
  type OpenAiChatGptDatabase,
} from './store';
import type { OpenAiChatGptConnection } from './types';

/**
 * Refreshes the delegated OpenAI access token for a "Sign in with ChatGPT"
 * connection. The stored access token is returned unchanged while it has more
 * than `REFRESH_WINDOW_SECONDS` left; otherwise the refresh happens under a row
 * lock, in a single transaction, so one refresh happens per connection even
 * across concurrent instances.
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

/** Shown when the connection can no longer be refreshed and must be reconnected. */
export const OPENAI_CHATGPT_RECONNECT_MESSAGE =
  'Your ChatGPT connection has expired. Reconnect to continue.';

/**
 * OAuth error codes that mean the stored refresh token can never work again.
 * The credential is dead: `markOpenAiChatGptError` clears the stored OpenAI
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

type RefreshDecision =
  | { kind: 'access_token'; accessToken: string }
  | { kind: 'no_connection' }
  | { kind: 'terminal' }
  | { kind: 'failed' };

/**
 * Single-flight per user within one process: concurrent callers share the same
 * in-flight refresh instead of each issuing their own request.
 */
const inFlightRefreshes = new Map<string, Promise<string | null>>();

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
 * Logs only the OAuth error code and the user id. The message names no
 * credential and prints no value: a log line is written once and read forever.
 */
function logRefreshFailure(userId: string, errorCode: string): void {
  console.error('[openai-chatgpt] refresh failed: %s (user %s)', errorCode, userId);
}

function isRetryableRefreshFailure(response: Response, errorCode: string | undefined): boolean {
  if (errorCode === RETRYABLE_REFRESH_ERROR_CODE) return true;
  return response.status === 409 || response.status === 429 || response.status >= 500;
}

/**
 * Runs the refresh and persists the rotated pair on success, inside the
 * transaction that holds the row lock. Retryable failures back off and retry up
 * to `OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS`; terminal failures return
 * `terminal` so the caller can disable the connection outside the lock.
 */
async function refreshWithRetries(
  tx: OpenAiChatGptDatabase,
  userId: string,
  connection: OpenAiChatGptConnection
): Promise<RefreshDecision> {
  const refreshToken = connection.refresh_token;
  if (!refreshToken) {
    // Without a refresh token there is nothing to rotate; the connection can
    // only be recovered by signing in again.
    return { kind: 'terminal' };
  }

  for (let attempt = 1; attempt <= OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS; attempt++) {
    const response = await postRefreshRequest(refreshToken);
    const body = await readResponseBody(response);

    if (response.ok) {
      const accessToken = readStringField(body, 'access_token');
      const expiresIn = readExpiresIn(body);
      if (accessToken && expiresIn) {
        const updated: OpenAiChatGptConnection = {
          ...connection,
          access_token: accessToken,
          refresh_token: readStringField(body, 'refresh_token') ?? refreshToken,
          expires_at: nowSeconds() + expiresIn,
          scope: readStringField(body, 'scope') ?? connection.scope,
          token_type: readStringField(body, 'token_type') ?? connection.token_type,
          status: 'connected',
          error_message: undefined,
          error_at: undefined,
        };

        await tx
          .update(byok_api_keys)
          .set({
            encrypted_api_key: encryptApiKey(JSON.stringify(updated), BYOK_ENCRYPTION_KEY),
            is_enabled: true,
          })
          .where(
            and(
              eq(byok_api_keys.kilo_user_id, userId),
              eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
            )
          );

        return { kind: 'access_token', accessToken };
      }
    }

    const errorCode = readOAuthErrorCode(body) ?? `http_${response.status}`;
    logRefreshFailure(userId, errorCode);

    if (TERMINAL_REFRESH_ERROR_CODES.has(errorCode)) {
      return { kind: 'terminal' };
    }

    const isLastAttempt = attempt === OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS;
    if (isLastAttempt || !isRetryableRefreshFailure(response, errorCode)) {
      return { kind: 'failed' };
    }

    await sleep(backoffDelayMs(attempt));
  }

  return { kind: 'failed' };
}

/**
 * Re-reads the connection under the row lock so a sibling instance that already
 * refreshed is not refreshed again, then returns the fresh token or decides to
 * refresh.
 */
async function resolveInsideLock(
  tx: OpenAiChatGptDatabase,
  userId: string
): Promise<RefreshDecision> {
  const row = await readOpenAiChatGptConnectionRow(tx, userId, { forUpdate: true });
  if (!row) return { kind: 'no_connection' };

  const connection = decryptOpenAiChatGptConnection(row.encrypted_api_key);
  if (!connection) return { kind: 'no_connection' };

  if (connection.expires_at - nowSeconds() > OPENAI_CHATGPT_REFRESH_WINDOW_SECONDS) {
    return { kind: 'access_token', accessToken: connection.access_token };
  }

  return refreshWithRetries(tx, userId, connection);
}

async function refreshOpenAiChatGptAccessToken(userId: string): Promise<string | null> {
  try {
    if (!OPENAI_CLIENT_ID || !OPENAI_CLIENT_SECRET) {
      console.error(
        '[openai-chatgpt] refresh failed: missing client configuration (user %s)',
        userId
      );
      return null;
    }

    // Fast path: no lock, no network call while the stored token is fresh.
    const row = await readOpenAiChatGptConnectionRow(db, userId);
    const current = row ? decryptOpenAiChatGptConnection(row.encrypted_api_key) : null;
    if (
      current &&
      current.expires_at - nowSeconds() > OPENAI_CHATGPT_REFRESH_WINDOW_SECONDS &&
      current.access_token
    ) {
      return current.access_token;
    }

    const decision = await db.transaction(tx => resolveInsideLock(tx, userId));

    if (decision.kind === 'terminal') {
      await markOpenAiChatGptError(userId, OPENAI_CHATGPT_RECONNECT_MESSAGE);
      return null;
    }

    return decision.kind === 'access_token' ? decision.accessToken : null;
  } catch (error) {
    // A thrown error must never carry a credential: log only its type and the user.
    console.error(
      '[openai-chatgpt] refresh errored: %s (user %s)',
      error instanceof Error ? error.name : 'UnknownError',
      userId
    );
    return null;
  }
}

/**
 * Returns a usable OpenAI access token for the user's ChatGPT connection, or
 * null when there is no connection, no refresh token, or the connection can no
 * longer be refreshed. Concurrent calls within one process share one refresh.
 */
export function ensureFreshOpenAiChatGptAccessToken(userId: string): Promise<string | null> {
  const existing = inFlightRefreshes.get(userId);
  if (existing) return existing;

  const pending = refreshOpenAiChatGptAccessToken(userId).finally(() => {
    inFlightRefreshes.delete(userId);
  });
  inFlightRefreshes.set(userId, pending);
  return pending;
}
