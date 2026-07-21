import 'server-only';

import { z } from 'zod';
import { GIT_TOKEN_SERVICE_API_URL } from '@/lib/config.server';
import { generateInternalServiceToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { GITHUB_USER_ACCESS_TOKEN_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

export const GitHubUserAccessTokenOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('fetch') }).strict(),
  z
    .object({
      op: z.literal('rotate'),
      staleAuthorizationId: z.string().min(1),
      staleCredentialVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      op: z.literal('reportRejected'),
      authorizationId: z.string().min(1),
      credentialVersion: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type GitHubUserAccessTokenOp = z.infer<typeof GitHubUserAccessTokenOpSchema>;

const GitHubUserAccessTokenRequestBodySchema = z.union([
  z.object({ op: z.literal('fetch') }).strict(),
  z
    .object({
      op: z.literal('rotate'),
      staleAuthorizationId: z.string(),
      staleCredentialVersion: z.number(),
    })
    .strict(),
  z
    .object({
      op: z.literal('reportRejected'),
      authorizationId: z.string(),
      credentialVersion: z.number(),
    })
    .strict(),
]);

const GitHubUserAccessTokenConnectedSchema = z
  .object({
    connected: z.literal(true),
    token: z.string().min(1),
    expiresAtEpochMs: z.number().int().positive(),
    githubLogin: z.string().min(1),
    authorizationId: z.string().min(1),
    credentialVersion: z.number().int().nonnegative(),
  })
  .strict();

const GitHubUserAccessTokenDisconnectedSchema = z
  .object({
    connected: z.literal(false),
    reason: z.enum(['not_connected', 'revoked']),
  })
  .strict();

export const GitHubUserAccessTokenResponseSchema = z.union([
  GitHubUserAccessTokenConnectedSchema,
  GitHubUserAccessTokenDisconnectedSchema,
]);
export type GitHubUserAccessTokenResponse = z.infer<typeof GitHubUserAccessTokenResponseSchema>;

export type GitHubUserAccessTokenConnected = z.infer<typeof GitHubUserAccessTokenConnectedSchema>;

export type GitHubUserAccessTokenResult =
  | { status: 'connected'; credential: GitHubUserAccessTokenConnected }
  | { status: 'disconnected'; reason: 'not_connected' | 'revoked' }
  | { status: 'temporarily_unavailable' };

const CACHE_REFRESH_HEADROOM_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

type CachedCredential = GitHubUserAccessTokenConnected;

const cache = new Map<string, CachedCredential>();
const queue = new Map<string, Promise<unknown>>();

async function enqueueForUser<T>(userId: string, op: () => Promise<T>): Promise<T> {
  const previous = queue.get(userId);
  const next = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // A failed earlier op must not poison the queue.
      }
    }
    return op();
  })() as Promise<T>;
  const queueEntry = next.catch(() => undefined);
  queue.set(userId, queueEntry);
  try {
    return await next;
  } finally {
    if (queue.get(userId) === queueEntry) {
      queue.delete(userId);
    }
  }
}

function readCache(userId: string): CachedCredential | undefined {
  const entry = cache.get(userId);
  if (!entry) return undefined;
  if (entry.expiresAtEpochMs - Date.now() <= CACHE_REFRESH_HEADROOM_MS) {
    cache.delete(userId);
    return undefined;
  }
  return entry;
}

function cacheForUser(userId: string, credential: CachedCredential | null): void {
  if (credential === null) {
    cache.delete(userId);
    return;
  }
  cache.set(userId, credential);
}

async function callTokenService(
  userId: string,
  body: GitHubUserAccessTokenOp
): Promise<GitHubUserAccessTokenResult> {
  if (!GIT_TOKEN_SERVICE_API_URL) {
    return { status: 'temporarily_unavailable' };
  }
  const parsedBody = GitHubUserAccessTokenRequestBodySchema.safeParse(body);
  if (!parsedBody.success) {
    return { status: 'temporarily_unavailable' };
  }
  const serviceToken = generateInternalServiceToken(userId, {
    expiresIn: TOKEN_EXPIRY.fiveMinutes,
    audience: GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
  });
  let response: Response;
  try {
    response = await fetch(
      `${GIT_TOKEN_SERVICE_API_URL}/internal/github-user-authorizations/token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceToken}`,
        },
        body: JSON.stringify(parsedBody.data),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch {
    return { status: 'temporarily_unavailable' };
  }
  if (response.status === 503) {
    return { status: 'temporarily_unavailable' };
  }
  if (response.status === 400 || response.status === 401) {
    // Surface upstream contract errors as a non-retryable disconnected result.
    // 400 invalid_request and 401 unauthorized both indicate the request is
    // structurally wrong / not authenticated; the caller should treat the
    // user as needing to reconnect.
    return { status: 'disconnected', reason: 'not_connected' };
  }
  if (!response.ok) {
    return { status: 'temporarily_unavailable' };
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { status: 'temporarily_unavailable' };
  }
  const parsed = GitHubUserAccessTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'temporarily_unavailable' };
  }
  if (parsed.data.connected) {
    return { status: 'connected', credential: parsed.data };
  }
  return { status: 'disconnected', reason: parsed.data.reason };
}

export async function getGitHubUserAccessToken(
  kiloUserId: string,
  op: GitHubUserAccessTokenOp
): Promise<GitHubUserAccessTokenResult> {
  if (op.op === 'fetch') {
    const cached = readCache(kiloUserId);
    if (cached) {
      return { status: 'connected', credential: cached };
    }
    return enqueueForUser(kiloUserId, async () => {
      // Re-check cache after acquiring the queue slot in case a previous
      // operation populated it while we were waiting.
      const cachedAfterWait = readCache(kiloUserId);
      if (cachedAfterWait) {
        return { status: 'connected', credential: cachedAfterWait } as const;
      }
      const result = await callTokenService(kiloUserId, op);
      if (result.status === 'connected') {
        cacheForUser(kiloUserId, result.credential);
      }
      return result;
    });
  }

  if (op.op === 'rotate') {
    return enqueueForUser(kiloUserId, async () => {
      const result = await callTokenService(kiloUserId, op);
      if (result.status === 'connected') {
        cacheForUser(kiloUserId, result.credential);
      } else {
        // Rotate failed or returned disconnected/revoked: evict any prior
        // cached entry — the stale credential is no longer trustworthy.
        cacheForUser(kiloUserId, null);
      }
      return result;
    });
  }

  // reportRejected
  return enqueueForUser(kiloUserId, async () => {
    const result = await callTokenService(kiloUserId, op);
    // Always evict the matching generation so future fetches refresh.
    const cached = readCache(kiloUserId);
    if (
      cached &&
      cached.authorizationId === op.authorizationId &&
      cached.credentialVersion <= op.credentialVersion
    ) {
      cacheForUser(kiloUserId, null);
    }
    return result;
  });
}

/**
 * Test-only helper: reset the in-process cache and per-user queue. NOT exported
 * via the module's public API surface — only consumed by jest tests in the
 * same package.
 */
export function __resetGitHubUserAccessTokenClientForTests(): void {
  cache.clear();
  queue.clear();
}
