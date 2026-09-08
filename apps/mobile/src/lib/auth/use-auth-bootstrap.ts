import * as SecureStore from 'expo-secure-store';
import { type Dispatch, type SetStateAction, useCallback, useEffect } from 'react';

import { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';
import { readUserIdFromToken } from '@/lib/auth/auth-user-id';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';
import {
  getActiveToken,
  getActiveTokenSnapshot,
  getAuthTokenForRequest,
  setActiveToken,
} from '@/lib/auth/token-owner';
import { setCurrentDeepLinkUserId } from '@/lib/deep-link-launch';
import { AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, TOKEN_EXPIRES_AT_KEY } from '@/lib/storage-keys';

// Pre-load tokens at module level so they're available before React mounts
export const preloadedAuthToken = getAuthTokenForRequest();
const preloadedRefreshToken = SecureStore.getItemAsync(REFRESH_TOKEN_KEY);

async function observePreloadRejection(preload: Promise<string | null>): Promise<void> {
  try {
    await preload;
  } catch {
    // Bootstrap owns the restore outcome.
  }
}

void observePreloadRejection(preloadedAuthToken);
void observePreloadRejection(preloadedRefreshToken);

type AuthBootstrapOptions = {
  setToken: Dispatch<SetStateAction<string | undefined>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setRestoreFailed: Dispatch<SetStateAction<boolean>>;
};

export function useAuthBootstrap({
  setToken,
  setIsLoading,
  setRestoreFailed,
}: AuthBootstrapOptions) {
  const load = useCallback(
    async (preload?: {
      readonly token: Promise<string | null>;
      readonly refresh: Promise<string | null>;
    }) => {
      const epoch = currentAuthEpoch();
      try {
        const stored = await (preload?.token ?? getAuthTokenForRequest());
        if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
          return;
        }
        if (stored) {
          const owner = getActiveTokenSnapshot();
          if (owner?.token === stored && owner.bundle) {
            setRestoreFailed(false);
            setToken(stored);
            setCurrentDeepLinkUserId(readUserIdFromToken(stored));
            return;
          }
          const storedRefresh = await readStoredValueWithRetry(
            REFRESH_TOKEN_KEY,
            undefined,
            preload?.refresh
          );
          if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
            return;
          }
          setRestoreFailed(false);
          // Legacy exchange: if we have a token but no refresh token, upgrade once.
          if (!storedRefresh) {
            const pair = await exchangeLegacyToken();
            if (pair && isCurrentAuthEpoch(epoch) && !isSignOutActive()) {
              setToken(pair.token);
              setCurrentDeepLinkUserId(readUserIdFromToken(pair.token));
              return;
            }
          }
          // The session moved while the preload or legacy exchange was in
          // flight: never resurrect the preloaded token.
          if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
            return;
          }
          const expiresAtStr = await readStoredValueWithRetry(TOKEN_EXPIRES_AT_KEY);
          // Fence the asynchronous expiry read: a sign-out or newer sign-in
          // during the reads owns the session, so the stale snapshot must not
          // be republished and nothing may be surfaced for the torn-down
          // session.
          const currentStored = await readStoredValueWithRetry(AUTH_TOKEN_KEY);
          if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
            return;
          }
          // A same-session refresh replaced the stored pair while the reads
          // were in flight. The preloaded snapshot is stale, but the session
          // is alive: publish the winner the refresh already put in the owner,
          // or the provider ends bootstrap with no token and sends a
          // signed-in user to the login screen.
          if (currentStored !== stored) {
            const published = getActiveToken()?.token ?? currentStored ?? undefined;
            setToken(published);
            setCurrentDeepLinkUserId(published ? readUserIdFromToken(published) : null);
            return;
          }
          setActiveToken(stored, expiresAtStr ? Number(expiresAtStr) : null);
          setToken(stored);
          setCurrentDeepLinkUserId(readUserIdFromToken(stored));
          return;
        }
        setRestoreFailed(false);
      } catch {
        if (isCurrentAuthEpoch(epoch) && !isSignOutActive()) {
          setRestoreFailed(true);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [setIsLoading, setRestoreFailed, setToken]
  );

  useEffect(() => {
    void load({ token: preloadedAuthToken, refresh: preloadedRefreshToken });
  }, [load]);

  const retryRestore = useCallback(() => {
    setIsLoading(true);
    void load();
  }, [load, setIsLoading]);

  return { retryRestore };
}
