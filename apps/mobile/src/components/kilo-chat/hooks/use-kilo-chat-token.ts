import * as SecureStore from 'expo-secure-store';
import { useCallback } from 'react';

import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';

type TokenCache = {
  authToken: string;
  token: string;
  expiresAtMs: number;
};

// Module-level cache keyed on the user's auth token, so a sign-out followed by
// a different sign-in within the JWT window doesn't return the previous user's
// token. The in-flight ref is keyed the same way for the same reason.
let cache: TokenCache | null = null;
let inFlight: { authToken: string; promise: Promise<string> } | null = null;

/**
 * Returns a stable getter function that fetches a kilo-chat JWT, caching it
 * until 60 seconds before expiry. Concurrent callers share a single in-flight
 * fetch via a module-level dedup ref.
 *
 * The auth token is read from SecureStore at call time (matching `trpcClient`)
 * rather than captured from `useAuth()`, so a getter constructed before auth
 * has loaded — or before the user signs in — picks up the correct token on
 * its next call instead of permanently capturing `undefined`.
 */
export function useKiloChatTokenGetter(): () => Promise<string> {
  return useCallback(async () => {
    const authToken = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
    if (!authToken) {
      throw new Error('Cannot fetch kilo-chat token: not authenticated');
    }

    if (cache && cache.authToken === authToken && cache.expiresAtMs - Date.now() > 60_000) {
      return cache.token;
    }

    if (inFlight && inFlight.authToken === authToken) {
      return inFlight.promise;
    }

    const slot = { authToken, promise: fetchAndCacheToken(authToken) };
    inFlight = slot;
    try {
      return await slot.promise;
    } finally {
      // Only clear the slot if a concurrent caller hasn't replaced it.
      if (inFlight === slot) {
        inFlight = null;
      }
    }
  }, []);
}

async function fetchAndCacheToken(authToken: string): Promise<string> {
  const { token, expiresAt } = await trpcClient.kiloChat.getToken.query();
  cache = { authToken, token, expiresAtMs: new Date(expiresAt).getTime() };
  return token;
}
