import * as SecureStore from 'expo-secure-store';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';

type ActiveTokenState = {
  token: string;
  expiresAtMs: number | null;
  epoch: number;
};

export type ActiveToken = {
  token: string;
  expiresAtMs: number | null;
};

export type ActiveTokenSnapshot = ActiveToken & { epoch: number; generation: number };

let activeToken: ActiveTokenState | null = null;
let activeTokenGeneration = 0;

/** Holds the token in memory, tagged with the auth epoch that was current when it was stored. */
export function setActiveToken(token: string, expiresAtMs: number | null): void {
  activeTokenGeneration += 1;
  activeToken = { token, expiresAtMs, epoch: currentAuthEpoch() };
}

/** Returns the held token and expiry, or null when unset or when the epoch moved. */
export function getActiveToken(): ActiveToken | null {
  if (!activeToken || !isCurrentAuthEpoch(activeToken.epoch)) {
    return null;
  }
  return { token: activeToken.token, expiresAtMs: activeToken.expiresAtMs };
}

export function getActiveTokenSnapshot(): ActiveTokenSnapshot | null {
  if (!activeToken || !isCurrentAuthEpoch(activeToken.epoch)) {
    return null;
  }
  return { ...activeToken, generation: activeTokenGeneration };
}

/**
 * Publishes a resolved expiry into the held owner after the cold path read
 * `TOKEN_EXPIRES_AT_KEY`. Applies only when the owner still holds the same
 * token for the current epoch, so a newer owner published while the expiry
 * was read is never overwritten.
 */
export function publishActiveTokenExpiry(
  snapshot: ActiveTokenSnapshot,
  expiresAtMs: number | null
): void {
  if (
    !activeToken ||
    activeToken.token !== snapshot.token ||
    activeToken.epoch !== snapshot.epoch ||
    activeTokenGeneration !== snapshot.generation ||
    !isCurrentAuthEpoch(activeToken.epoch)
  ) {
    return;
  }
  activeToken = { ...activeToken, expiresAtMs };
}

export function clearActiveToken(): void {
  activeToken = null;
}

/**
 * The single shared token read for outgoing requests. Returns the in-memory
 * token when one is held for the current auth epoch; otherwise reads
 * SecureStore once and — only if the epoch is unchanged and no newer owner was
 * published while reading — warms the owner so the next read is an in-memory
 * hit. A read that races an epoch bump still returns what it read (one-shot
 * request), but never warms the owner, and an owner published during the read
 * wins over the stored value.
 */
export async function getAuthTokenForRequest(): Promise<string | null> {
  const active = getActiveToken();
  if (active) {
    return active.token;
  }
  const epoch = currentAuthEpoch();
  const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  // A sign-in or refresh may have published a newer owner while the cold read
  // was in flight: prefer it and never overwrite it with the stale read.
  const published = getActiveToken();
  if (published) {
    return published.token;
  }
  if (token && isCurrentAuthEpoch(epoch)) {
    setActiveToken(token, null);
  }
  return token;
}
