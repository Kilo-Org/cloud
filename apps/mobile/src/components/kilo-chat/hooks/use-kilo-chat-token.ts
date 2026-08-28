import { useCallback } from 'react';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { type AuthenticatedOwner, getAuthenticatedOwner } from '@/lib/context-scope';
import { LocalAccessDeniedError } from '@/lib/local-access';
import { assertTransportOwner, isTransportOwner } from '@/lib/local-access-transport';
import { parseTimestamp } from '@/lib/utils';
import { trpcClient } from '@/lib/trpc';

type KiloChatTokenResponse = Awaited<ReturnType<typeof trpcClient.kiloChat.getToken.query>>;
type TokenCache = {
  authToken: string;
  owner: AuthenticatedOwner;
  response: KiloChatTokenResponse;
  expiresAtMs: number;
};
type TokenResponseListener = (response: KiloChatTokenResponse, owner: AuthenticatedOwner) => void;
type TokenResponseGetter = (assertDispatch?: () => void) => Promise<KiloChatTokenResponse>;

let cache: TokenCache | null = null;
let inFlight: {
  authToken: string;
  owner: AuthenticatedOwner;
  promise: Promise<KiloChatTokenResponse>;
} | null = null;
let cacheGeneration = 0;
const tokenResponseListeners = new Set<TokenResponseListener>();

export function clearKiloChatTokenCache(): void {
  cacheGeneration += 1;
  cache = null;
  inFlight = null;
}

export function subscribeToKiloChatTokenResponses(listener: TokenResponseListener): () => void {
  tokenResponseListeners.add(listener);
  return () => {
    tokenResponseListeners.delete(listener);
  };
}

/** The provider supplies its immutable owner; standalone reads capture their owner at invocation. */
export function useKiloChatTokenGetter(owner?: AuthenticatedOwner): () => Promise<string> {
  const getTokenResponse = useKiloChatTokenResponseGetter(owner);
  return useCallback(async () => {
    const response = await getTokenResponse();
    return response.token;
  }, [getTokenResponse]);
}

function sameGeneration(left: AuthenticatedOwner, right: AuthenticatedOwner): boolean {
  return left.authEpoch === right.authEpoch && left.generation === right.generation;
}

export function useKiloChatTokenResponseGetter(owner?: AuthenticatedOwner): TokenResponseGetter {
  return useCallback(
    async assertDispatch => {
      const capturedOwner = owner ?? getAuthenticatedOwner();
      const generation = cacheGeneration;
      const assertCurrent = () => {
        assertTransportOwner(capturedOwner);
        if (generation !== cacheGeneration) {
          throw new LocalAccessDeniedError('stale');
        }
        assertDispatch?.();
      };
      assertCurrent();
      const authToken = await getAuthTokenForRequest();
      assertCurrent();
      if (!authToken) {
        throw new Error('Cannot fetch kilo-chat token: not authenticated');
      }
      if (
        cache?.authToken === authToken &&
        sameGeneration(cache.owner, capturedOwner) &&
        cache.expiresAtMs - Date.now() > 60_000
      ) {
        return cache.response;
      }
      if (inFlight?.authToken === authToken && sameGeneration(inFlight.owner, capturedOwner)) {
        const response = await inFlight.promise;
        assertCurrent();
        return response;
      }
      const slot = {
        authToken,
        owner: capturedOwner,
        promise: fetchAndCacheToken(authToken, capturedOwner, generation),
      };
      inFlight = slot;
      try {
        const response = await slot.promise;
        assertCurrent();
        return response;
      } finally {
        if (inFlight === slot) {
          inFlight = null;
        }
      }
    },
    [owner]
  );
}

async function fetchAndCacheToken(
  authToken: string,
  owner: AuthenticatedOwner,
  generation: number
): Promise<KiloChatTokenResponse> {
  assertTransportOwner(owner);
  const response = await trpcClient.kiloChat.getToken.query(undefined, {
    context: { localAccessOwner: owner },
  });
  assertTransportOwner(owner);
  if (generation !== cacheGeneration) {
    throw new LocalAccessDeniedError('stale');
  }
  const userId = getAuthenticatedOwner().userId;
  if (userId !== null && response.userId !== userId) {
    throw new LocalAccessDeniedError('owner');
  }
  cache = { authToken, owner, response, expiresAtMs: parseTimestamp(response.expiresAt).getTime() };
  for (const listener of tokenResponseListeners) {
    if (!isTransportOwner(owner)) {
      break;
    }
    listener(response, owner);
  }
  assertTransportOwner(owner);
  return response;
}
