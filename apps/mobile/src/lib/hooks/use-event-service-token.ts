import { useCallback } from 'react';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { parseTimestamp } from '@/lib/utils';
import { trpcClient } from '@/lib/trpc';

type EventServiceTokenResponse = inferRouterOutputs<MobileRouter>['kiloChat']['getToken'];

type TokenCache = {
  authToken: string;
  response: EventServiceTokenResponse;
  expiresAtMs: number;
};

let cache: TokenCache | null = null;
let inFlight: { authToken: string; promise: Promise<EventServiceTokenResponse> } | null = null;

export function clearEventServiceTokenCache(): void {
  cache = null;
  inFlight = null;
}

export function useEventServiceTokenGetter(): () => Promise<string> {
  const getTokenResponse = useEventServiceTokenResponseGetter();
  return useCallback(async () => {
    const response = await getTokenResponse();
    return response.token;
  }, [getTokenResponse]);
}

function useEventServiceTokenResponseGetter(): () => Promise<EventServiceTokenResponse> {
  return useCallback(async () => {
    const authToken = await getAuthTokenForRequest();
    if (!authToken) {
      throw new Error('Cannot fetch event-service token: not authenticated');
    }

    if (cache?.authToken === authToken && cache.expiresAtMs - Date.now() > 60_000) {
      return cache.response;
    }

    if (inFlight?.authToken === authToken) {
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

async function fetchAndCacheToken(authToken: string): Promise<EventServiceTokenResponse> {
  const response = await trpcClient.kiloChat.getToken.query();
  cache = { authToken, response, expiresAtMs: parseTimestamp(response.expiresAt).getTime() };
  return response;
}
