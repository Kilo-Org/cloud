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

export async function getKiloChatToken(): Promise<string> {
  // Return cached token if still fresh (5 min buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }
  // Deduplicate concurrent requests
  if (!inflightRequest) {
    inflightRequest = fetchToken().finally(() => {
      inflightRequest = null;
    });
  }
  return inflightRequest;
}
