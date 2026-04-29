import { useCallback, useRef } from 'react';

import { trpcClient } from '@/lib/trpc';

type TokenCache = {
  token: string;
  expiresAtMs: number;
};

/**
 * Returns a stable getter function that fetches a kilo-chat JWT, caching it
 * until 60 seconds before expiry. Concurrent callers share a single in-flight
 * fetch via a dedup ref.
 */
export function useKiloChatTokenGetter(): () => Promise<string> {
  const cacheRef = useRef<TokenCache | null>(null);
  const inFlightRef = useRef<Promise<string> | null>(null);

  return useCallback(async () => {
    const cached = cacheRef.current;
    if (cached && cached.expiresAtMs - Date.now() > 60_000) {
      return cached.token;
    }

    const existing = inFlightRef.current;
    if (existing) {
      return existing;
    }

    // Create a shared promise and set inFlightRef before awaiting so concurrent
    // callers share this fetch rather than starting duplicate requests.
    let resolveShared: (token: string) => void = () => undefined;
    const sharedPromise = new Promise<string>(resolve => {
      resolveShared = resolve;
    });
    inFlightRef.current = sharedPromise;

    const { token, expiresAt } = await trpcClient.kiloChat.getToken.query();
    const expiresAtMs = new Date(expiresAt).getTime();
    cacheRef.current = { token, expiresAtMs };
    inFlightRef.current = null;
    resolveShared(token);
    return token;
  }, []);
}
