import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { discardPostHog } from '@/lib/analytics/posthog';
import { resetAppsFlyerState, trackEvent } from '@/lib/appsflyer';
import { clearPendingDeepLink, setCurrentDeepLinkUserId } from '@/lib/deep-link-launch';
import { deleteAccountMetadata } from '@/lib/auth/account-metadata-write';
import { runLogoutCleanup } from '@/lib/auth/logout-cleanup';
import { queryClient } from '@/lib/query-client';
import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';
import { exchangeLegacyToken } from '@/lib/auth/exchange-legacy-token';
import { bumpAuthEpoch, currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import {
  IOS_BEARER_SECURE_STORE_OPTIONS,
  performRefresh,
  persistSignInCredentialsAtEpoch,
  REFRESH_MARGIN_MS,
  writeCredentials,
} from '@/lib/auth/credentials';
import {
  clearActiveToken,
  getActiveToken,
  setActiveToken,
  setSignOutTeardownActive,
} from '@/lib/auth/token-owner';
import { chainSave } from '@/lib/hooks/save-chain';
import { clearAgentModelPreference } from '@/lib/hooks/use-persisted-agent-model';
import { clearKeepScreenOnPreference } from '@/lib/hooks/use-keep-screen-on-preference';
import { clearReasoningPreference } from '@/lib/hooks/use-reasoning-preference';
import { clearTrustedHosts } from '@/lib/hooks/use-trusted-hosts';
import { clearMarkdownImageConfirmMemory } from '@/components/agents/markdown-image-confirm';
import { clearKiloClawOwned, gateKiloClawOwned } from '@/lib/kiloclaw-tab-ownership';
import { clearLastActiveInstance } from '@/lib/last-active-instance';
import { resetPurchaseErrorToastDedup } from '@/lib/kilo-pass/use-store-kilo-pass-purchase';
import {
  isSignOutActive,
  setSignOutActive,
  subscribeSignOutActive,
} from '@/lib/auth/sign-out-state';
import { clearCacheScopeForSignOut, readCachedUserId } from '@/lib/persist/read-cache';
import { clearSessionAttentionForSignOut } from '@/lib/session-attention';
import { clearRecentPrs } from '@/lib/pr-review/recent-prs';
import { clearViewedFiles } from '@/lib/pr-review/viewed-files';
import {
  ACTIVE_USER_ID_KEY,
  AUTH_TOKEN_KEY,
  LEGACY_EXCHANGE_DONE_KEY,
  NOTIFICATION_PROMPT_SEEN_KEY,
  ORGANIZATION_STORAGE_KEY,
  PENDING_DEEP_LINK_KEY,
  PICKER_LAUNCH_CONTEXT_KEY,
  REFRESH_TOKEN_KEY,
  SESSION_FILTERS_KEY,
  TOKEN_EXPIRES_AT_KEY,
} from '@/lib/storage-keys';
import { clearTelemetryDecision } from '@/lib/telemetry/controller';
import { clearSentryUser } from '@/lib/sentry-context';
import { purgePostHogPersistence } from '@/lib/telemetry/posthog-storage';
import { AppState } from 'react-native';

// Pre-load tokens at module level so they're available before React mounts
export const preloadedAuthToken = SecureStore.getItemAsync(AUTH_TOKEN_KEY);
const preloadedRefreshToken = SecureStore.getItemAsync(REFRESH_TOKEN_KEY);

const jwtPayloadSchema = z.object({ kiloUserId: z.string().optional() });

/**
 * Best-effort read of the signed-in user id from a Kilo bearer token. The
 * token is a JWT whose payload carries `kiloUserId` (see `generateApiToken`
 * in apps/web/src/lib/tokens.ts). Decode-only: the server already accepted
 * the token, so the id is read without verifying the signature (the app has
 * no signing secret). Returns null for a non-JWT or malformed token so a
 * decode failure can never break sign-in.
 */
function readUserIdFromToken(token: string): string | null {
  try {
    const segments = token.split('.');
    if (segments.length !== 3) {
      return null;
    }
    const payloadSegment = segments[1];
    if (payloadSegment === undefined) {
      return null;
    }
    const base64 = payloadSegment.replaceAll('-', '+').replaceAll('_', '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const parsed = jwtPayloadSchema.safeParse(JSON.parse(atob(padded)));
    return parsed.success && parsed.data.kiloUserId ? parsed.data.kiloUserId : null;
  } catch {
    return null;
  }
}

type AuthContextValue = {
  token: string | undefined;
  isLoading: boolean;
  sessionEnded: boolean;
  /** Reactive snapshot of the auth epoch; bumps when sign-in or sign-out
   *  advances it, so subscribers (e.g. the read-cache mount) can resubscribe. */
  authEpoch: number;
  /** Reactive view of the shared sign-out flag (`@/lib/auth/sign-out-state`):
   *  true from the synchronous start of sign-out until a sign-in's credential
   *  publication succeeds. The read-cache mount refuses to subscribe while it
   *  is set, and the persister fence reads the same flag at write time. */
  isSigningOut: boolean;
  signIn: (token: string, refreshToken?: string, expiresIn?: number) => Promise<void>;
  signOut: (ended?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [token, setToken] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [sessionEnded, setSessionEnded] = useState(false);
  // Reactive snapshot of the module auth epoch, advanced synchronously at the
  // start of sign-in and sign-out so a subscriber can resubscribe on the bump.
  const [authEpoch, setAuthEpoch] = useState(() => currentAuthEpoch());
  // Reactive view of the one sign-out flag the cache write fence also reads.
  // `setSignOutActive` flips it synchronously at the start of sign-out (same
  // render as the epoch bump) so the read-cache mount cannot resubscribe while
  // the old user id is still cached; it is cleared only after a sign-in's
  // credential publication succeeds.
  const isSigningOut = useSyncExternalStore(subscribeSignOutActive, isSignOutActive);
  const isSignedOutReference = useRef(false);

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

        if (stored) {
          // Legacy exchange: if we have a token but no refresh token, upgrade once.
          if (!storedRefresh) {
            const pair = await exchangeLegacyToken();
            if (pair) {
              setToken(pair.token);
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
            setToken(getActiveToken()?.token ?? currentStored ?? undefined);
            return;
          }
          setActiveToken(stored, expiresAtStr ? Number(expiresAtStr) : null);
          setToken(stored);
        }
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const signIn = useCallback(
    async (tokenValue: string, refreshTokenValue?: string, expiresIn?: number) => {
      // The ENTIRE sign-in body runs inside the FIFO auth-transition queue, so
      // a sign-in queued behind an in-flight sign-out lands only after the
      // full teardown, and a sign-out queued behind a sign-in signs that new
      // session out (documented, correct FIFO semantics).
      await chainSave('auth-transition', async () => {
        bumpAuthEpoch();
        setAuthEpoch(currentAuthEpoch());
        // Bind the pending deep-link slot to the new user id at the same
        // place the auth epoch advances, so a destination captured while this
        // account is signed in restores only for this account.
        setCurrentDeepLinkUserId(readUserIdFromToken(tokenValue));
        const epoch = currentAuthEpoch();
        const published = await persistSignInCredentialsAtEpoch(tokenValue, refreshTokenValue, {
          expiresIn,
        });
        // A sign-in superseded by a newer sign-in or sign-out while its
        // credential write was fenced must not clear the signed-out guard,
        // update React auth state, or run login side effects.
        if (!published || !isCurrentAuthEpoch(epoch)) {
          return;
        }
        // Clear the guard so a later refused refresh can sign out again.
        isSignedOutReference.current = false;
        // Credentials published on the winning epoch: the teardown window
        // ends, so refresh may rotate the new session and request-token cold
        // reads may warm the owner again.
        setSignOutTeardownActive(false);
        setSessionEnded(false);
        // Credentials published on the winning epoch: the sign-out fence opens
        // so the read-cache mount can subscribe for the new session, and the
        // reactive `isSigningOut` follows the same flag.
        setSignOutActive(false);
        trackEvent('login');
        resetPurchaseErrorToastDedup();
        setToken(tokenValue);
        // A prior account's confirmed image URIs must not auto-load for this
        // new session.
        clearMarkdownImageConfirmMemory();
      });
    },
    []
  );

  const signOut = useCallback(async (ended = false) => {
    // The ENTIRE sign-out body runs inside the FIFO auth-transition queue.
    // Dedupe inside the queued run, not at enqueue: a sign-out queued behind
    // an in-flight sign-out (or after a completed teardown) no-ops, so
    // double sign-out runs teardown exactly once.
    await chainSave('auth-transition', async () => {
      if (isSignedOutReference.current) {
        return;
      }
      isSignedOutReference.current = true;
      // Close the teardown guard synchronously, before the first await: a
      // refresh or request-token cold read must not touch the old credentials
      // while the remote cleanup runs and the deletion batch is queued. The
      // in-memory owner still serves the cleanup's auth headers until the
      // epoch bump below.
      setSignOutTeardownActive(true);
      // Close the cache publication fence synchronously, before the epoch
      // bump and before any await, so a write can never land in the scope
      // that the cleanup below clears. The same flag drives the reactive
      // `isSigningOut`, which flips in the same render as the epoch bump, so
      // the read-cache mount unsubscribes and cannot resubscribe while the old
      // user id is still cached.
      setSignOutActive(true);
      // Drop the pending deep-link destination synchronously, before the
      // first await, so a different account signed in later in this process
      // cannot navigate to the previous account's destination. The in-memory
      // clear is synchronous; the persisted delete chains behind any
      // in-flight persist.
      clearPendingDeepLink();
      try {
        // Close ownership persistence before any await so a late list
        // response cannot write the previous account's answer during
        // teardown.
        gateKiloClawOwned();
        clearTelemetryDecision();
        clearSentryUser();
        // SDK teardown — drop queues, do not flush them. Must happen before
        // any SecureStore or cache awaits so optional analytics cannot
        // transmit during the teardown window. Each step is individually
        // caught: a telemetry failure must never block sign-out.
        resetAppsFlyerState();
        try {
          await discardPostHog();
        } catch {
          // Optional analytics teardown is best effort.
        }
        try {
          purgePostHogPersistence();
        } catch {
          // Optional telemetry storage purge is best effort.
        }
        // Remote cleanup (session revoke + push unregister + tombstone)
        // runs BEFORE the epoch bump while the token owner still serves auth
        // headers. Never throws by contract.
        await runLogoutCleanup();
      } finally {
        // The epoch bumps after remote cleanup (cleanup requests pass the
        // fence) and before any local deletion (no deferred save can land
        // after it).
        bumpAuthEpoch();
        setAuthEpoch(currentAuthEpoch());
        // The signed-out session owns no user id: a destination captured
        // during teardown is recorded as "captured while signed out".
        setCurrentDeepLinkUserId(null);
        clearActiveToken();
        try {
          // Independent local cleanup, concurrent via allSettled: a
          // rejection in any member must never stop the others or the
          // preference clears. The credential deletion and the identity-hint
          // deletion are members of the same always-attempted batch.
          await Promise.allSettled([
            writeCredentials(async () => {
              await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
              await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, IOS_BEARER_SECURE_STORE_OPTIONS);
              await SecureStore.deleteItemAsync(
                TOKEN_EXPIRES_AT_KEY,
                IOS_BEARER_SECURE_STORE_OPTIONS
              );
              await SecureStore.deleteItemAsync(LEGACY_EXCHANGE_DONE_KEY);
            }),
            deleteAccountMetadata(ACTIVE_USER_ID_KEY),
            deleteAccountMetadata(ORGANIZATION_STORAGE_KEY),
            deleteAccountMetadata(SESSION_FILTERS_KEY),
            deleteAccountMetadata(NOTIFICATION_PROMPT_SEEN_KEY),
            deleteAccountMetadata(PENDING_DEEP_LINK_KEY),
            deleteAccountMetadata(PICKER_LAUNCH_CONTEXT_KEY),
            // Phase 4b read-cache cleanup: capture the authoritative user
            // id from the getMe cache while it is still present (the batch
            // expression runs before queryClient.clear()), then remove that
            // user's cache scope (or every `cache:` scope when the id is
            // unknown — privacy wins). Best effort: a failed cleanup can
            // never abort sign-out.
            clearCacheScopeForSignOut(readCachedUserId(queryClient)),
            clearLastActiveInstance(),
            clearKiloClawOwned(),
            clearRecentPrs(),
            clearViewedFiles(),
            clearSessionAttentionForSignOut(),
          ]);
          // Synchronous preference clears so they don't leak to the next
          // signed-in account. A synchronous throw here still falls through
          // to the state reset below.
          clearAgentModelPreference();
          clearReasoningPreference();
          clearTrustedHosts();
          clearMarkdownImageConfirmMemory();
          clearKeepScreenOnPreference();
        } finally {
          queryClient.clear();
          setSessionEnded(ended);
          setToken(undefined);
        }
      }
    });
  }, []);

  // Unauthorized handler: try refresh first, sign out only on a refused 401.
  // A transient failure (network error, 5xx) keeps the active token.
  // performRefresh handles concurrent callers via its own single-flight lock.
  useEffect(() => {
    const handler = async () => {
      const outcome = await performRefresh();

      if (outcome.ok && isCurrentAuthEpoch(outcome.sessionVersion)) {
        setToken(outcome.token);
        // Invalidate all queries so failed authenticated work recovers
        // with the new token. UNAUTHORIZED errors have retry=0, so a
        // concurrent 401 will not auto-refetch without explicit invalidation.
        void queryClient.invalidateQueries();
        return;
      }

      if (!outcome.ok && outcome.refused && !isSignedOutReference.current) {
        await signOut(true);
      }
    };

    return setTrpcUnauthorizedHandler(handler);
  }, [signOut]);

  // Proactive refresh: when the app returns to foreground and the token is
  // expiring within the margin, rotate before the next request hits a 401.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' || !token) {
        return;
      }

      // Capture the epoch that owns this foreground event. A sign-out or
      // newer sign-in that lands while the expiry read is in flight makes
      // the event stale: it must not refresh on the old session or publish
      // a token after sign-out.
      const epoch = currentAuthEpoch();

      void (async () => {
        const expiresAtStr = await SecureStore.getItemAsync(TOKEN_EXPIRES_AT_KEY);
        if (!expiresAtStr) {
          return;
        }

        const expiresAt = Number(expiresAtStr);
        if (Date.now() <= expiresAt - REFRESH_MARGIN_MS) {
          return;
        }

        // The epoch moved while the expiry read was in flight: the event is
        // stale, so do not initiate a refresh for the old session.
        if (!isCurrentAuthEpoch(epoch)) {
          return;
        }

        const outcome = await performRefresh();

        if (outcome.ok && isCurrentAuthEpoch(outcome.sessionVersion)) {
          setToken(outcome.token);
        }
        // Transient or refused: do not sign out — the user did not trigger
        // an authenticated request. Let the next real 401 handle it.
      })();
    });
    return () => {
      subscription.remove();
    };
  }, [token]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, isLoading, sessionEnded, authEpoch, isSigningOut, signIn, signOut }),
    [token, isLoading, sessionEnded, authEpoch, isSigningOut, signIn, signOut]
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
