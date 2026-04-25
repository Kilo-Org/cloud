'use client';

/**
 * Kilo Chat token management — mirrors the Gastown pattern in
 * apps/web/src/lib/gastown/trpc.ts.
 *
 * Fetches a short-lived JWT from /api/kilo-chat/token (session-cookie-authed)
 * and caches it in module scope. Refreshes automatically when near expiry.
 * Concurrent callers share the same inflight request.
 */

import { z } from 'zod';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
let inflightRequest: Promise<string> | null = null;
let lastFailedAt: number = 0;
const RETRY_BACKOFF_MS = 5_000;

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/kilo-chat/token', { method: 'POST' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to fetch kilo-chat token: ${res.status} ${body}`);
  }
  const data: unknown = await res.json();
  const parsed = z.object({ token: z.string(), expiresAt: z.string() }).parse(data);
  cachedToken = parsed.token;
  tokenExpiresAt = new Date(parsed.expiresAt).getTime();
  return parsed.token;
}

/**
 * Clears the in-memory token cache so the next getKiloChatToken() call
 * refetches from /api/kilo-chat/token. Call this when the server has
 * rejected the token (e.g. 401/403 from a dependent service).
 */
export function clearKiloChatToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  lastFailedAt = 0;
  inflightRequest = null;
}

export async function getKiloChatToken(): Promise<string> {
  // Return cached token if still fresh (5 min buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }
  // Enforce minimum retry interval after failures to prevent tight retry loops
  if (lastFailedAt && Date.now() - lastFailedAt < RETRY_BACKOFF_MS) {
    throw new Error('Token fetch on cooldown after recent failure');
  }
  // Deduplicate concurrent requests
  if (!inflightRequest) {
    inflightRequest = fetchToken()
      .then(token => {
        lastFailedAt = 0;
        inflightRequest = null;
        return token;
      })
      .catch(err => {
        lastFailedAt = Date.now();
        inflightRequest = null;
        throw err;
      });
  }
  return inflightRequest;
}
