import { useCallback } from 'react';

import { trpcClient } from '@/lib/trpc';

type TokenCache = {
  token: string;
  expiresAtMs: number;
};

// Module-level singletons so all useKiloChatTokenGetter() instances share the
// same cache and in-flight dedup. Auth token is a per-app singleton (one
// logged-in user), so process-wide state is correct.
let cache: TokenCache | null = null;
let inFlight: Promise<string> | null = null;

/**
 * Returns a stable getter function that fetches a kilo-chat JWT, caching it
 * until 60 seconds before expiry. Concurrent callers share a single in-flight
 * fetch via a module-level dedup ref.
 */
export function useKiloChatTokenGetter(): () => Promise<string> {
  return useCallback(async () => {
    if (cache && cache.expiresAtMs - Date.now() > 60_000) {
      return cache.token;
    }

    if (inFlight) {
      return inFlight;
    }

    // Create a shared promise and set inFlight before awaiting so concurrent
    // callers share this fetch rather than starting duplicate requests.
    let resolveShared: (token: string) => void = () => undefined;
    let rejectShared: (err: unknown) => void = () => undefined;
    const sharedPromise = new Promise<string>((resolve, reject) => {
      resolveShared = resolve;
      rejectShared = reject;
    });
    inFlight = sharedPromise;

    try {
      const { token, expiresAt } = await trpcClient.kiloChat.getToken.query();
      const expiresAtMs = new Date(expiresAt).getTime();
      cache = { token, expiresAtMs };
      resolveShared(token);
      return token;
    } catch (error) {
      rejectShared(error);
      throw error;
    } finally {
      inFlight = null;
    }
  }, []);
}
