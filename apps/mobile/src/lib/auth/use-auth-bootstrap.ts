import * as SecureStore from 'expo-secure-store';
import { type Dispatch, type SetStateAction, useEffect } from 'react';

import { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';
import { readUserIdFromToken } from '@/lib/auth/auth-user-id';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
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

type AuthBootstrapOptions = {
  setToken: Dispatch<SetStateAction<string | undefined>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
};

export function useAuthBootstrap({ setToken, setIsLoading }: AuthBootstrapOptions): void {
  useEffect(() => {
    const load = async () => {
      try {
        // Capture the epoch before any asynchronous read: every later check
        // fences against this moment, so a sign-out or newer sign-in during
        // bootstrap can never be followed by the preloaded token being
        // restored into React state or the token owner.
        const epoch = currentAuthEpoch();
        const stored = await preloadedAuthToken;
        const storedRefresh = await preloadedRefreshToken;
        if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
          return;
        }
        if (stored) {
          const owner = getActiveTokenSnapshot();
          if (owner?.token === stored && owner.bundle) {
            if (isCurrentAuthEpoch(epoch)) {
              setToken(stored);
              setCurrentDeepLinkUserId(readUserIdFromToken(stored));
            }
            return;
          }
          // Legacy exchange: if we have a token but no refresh token, upgrade once.
          if (!storedRefresh) {
            const pair = await exchangeLegacyToken();
            if (pair) {
              setToken(pair.token);
              setCurrentDeepLinkUserId(readUserIdFromToken(pair.token));
              setIsLoading(false);
              return;
            }
          }
          // The session moved while the preload or legacy exchange was in
          // flight: never resurrect the preloaded token.
          if (!isCurrentAuthEpoch(epoch)) {
            return;
          }
          const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);
          // Fence the asynchronous expiry read: a sign-out or newer sign-in
          // during the reads owns the session, so the stale snapshot must not
          // be republished and nothing may be surfaced for the torn-down
          // session.
          const currentStored = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
          if (!isCurrentAuthEpoch(epoch)) {
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
        } else {
          const modernToken = await getAuthTokenForRequest();
          const owner = getActiveTokenSnapshot();
          if (
            modernToken &&
            owner?.token === modernToken &&
            owner.bundle &&
            isCurrentAuthEpoch(epoch)
          ) {
            setToken(modernToken);
            setCurrentDeepLinkUserId(readUserIdFromToken(modernToken));
          }
        }
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, [setIsLoading, setToken]);
}
