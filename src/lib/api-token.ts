import { z } from 'zod';

let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
let inflightRequest: Promise<string | null> | null = null;

async function fetchApiToken(): Promise<string | null> {
  const res = await fetch('/api/auth/token', { method: 'POST' });
  if (!res.ok) return null;
  const data: unknown = await res.json();
  const parsed = z.object({ token: z.string(), expiresAt: z.string() }).safeParse(data);
  if (!parsed.success) return null;
  cachedToken = parsed.data.token;
  tokenExpiresAt = new Date(parsed.data.expiresAt).getTime();
  return parsed.data.token;
}

/**
 * Returns a short-lived Kilo JWT for the current user, or null if not logged in.
 * The token can be sent as `Authorization: Bearer <token>` to authenticated API endpoints.
 * Refreshes automatically when near expiry (5 min buffer), deduplicating concurrent requests.
 */
export async function getApiToken(): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }
  if (!inflightRequest) {
    inflightRequest = fetchApiToken().finally(() => {
      inflightRequest = null;
    });
  }
  return inflightRequest;
}
