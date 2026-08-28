import { useNavigationContainerRef } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { useAuth } from '@/lib/auth/auth-context';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { getActiveTokenSnapshot, isSignOutTeardownActive } from '@/lib/auth/token-owner';
import {
  clearPendingDeepLink,
  getPendingDeepLinkRequestId,
  getPendingDeepLinkSnapshot,
  setPendingDeepLink,
} from '@/lib/deep-link-launch';
import {
  consumePendingDevSession,
  DEV_SESSION_MARKER,
  type DevSessionReplacement,
  getDevSessionSnapshot,
  isDevSessionDestinationCommitted,
  setDevSessionLoginReady,
  setDevSessionReplacement,
  subscribePendingDevSession,
} from '@/lib/dev-session-inject';

type Auth = ReturnType<typeof useAuth>;
let commitTimeout: ReturnType<typeof setTimeout> | undefined = undefined;

function report(requestId: number, message: string): void {
  if (__DEV__) {
    // eslint-disable-next-line no-console -- sanitized development admission evidence; never credentials or errors
    console.info('[dev-session]', requestId, message);
  }
}

function clearRequestDestination(requestId: number): void {
  if (getPendingDeepLinkRequestId() === requestId) {
    clearPendingDeepLink();
  }
}

export function rejectDevSessionRequest(requestId: number): void {
  const replacement = getDevSessionSnapshot().replacement;
  if (replacement?.request.id !== requestId || replacement.phase === 'blocked') {
    return;
  }
  clearTimeout(commitTimeout);
  clearRequestDestination(requestId);
  if (replacement.phase === 'enqueued') {
    // Expo's queued action cannot be cancelled. Never admit another account here.
    setDevSessionReplacement({ ...replacement, phase: 'blocked' });
    report(
      requestId,
      'Navigation did not commit. Restart the app before another mobile-open request.'
    );
  } else {
    setDevSessionReplacement(null);
    report(requestId, 'Replacement failed before navigation. Send a fresh mobile-open request.');
  }
}

async function tearDown(replacement: DevSessionReplacement, auth: Auth): Promise<void> {
  try {
    if (
      auth.token ||
      auth.isSigningOut ||
      isSignOutActive() ||
      isSignOutTeardownActive() ||
      getActiveTokenSnapshot()
    ) {
      await auth.signOut();
    }
    setDevSessionReplacement({ ...replacement, phase: 'login', epoch: currentAuthEpoch() });
  } catch {
    // A rejecting signOut can still clear React state in finally. It never admits this request.
    rejectDevSessionRequest(replacement.request.id);
  }
}

async function admit(replacement: DevSessionReplacement, signIn: Auth['signIn']): Promise<void> {
  const { request, epoch } = replacement;
  try {
    const { token, refreshToken, expiresIn } = request.credentials;
    await signIn(token, refreshToken, expiresIn);
    const owner = getActiveTokenSnapshot();
    if (
      currentAuthEpoch() !== epoch ||
      owner?.epoch !== epoch ||
      owner.token !== token ||
      isSignOutActive() ||
      isSignOutTeardownActive()
    ) {
      rejectDevSessionRequest(request.id);
      return;
    }
    setPendingDeepLink(request.href, 'universal-link', request.id);
    setDevSessionReplacement({ ...replacement, phase: 'admitted' });
  } catch {
    rejectDevSessionRequest(request.id);
  }
}

/** The login passive mount follows all authenticated-subtree passive cleanups. */
export function useDevSessionLoginCommit(): void {
  useEffect(() => {
    if (!__DEV__) {
      return undefined;
    }
    setDevSessionLoginReady(true);
    return () => {
      setDevSessionLoginReady(false);
    };
  }, []);
}

export function DevSessionInjector() {
  const auth = useAuth();
  const snapshot = useSyncExternalStore(subscribePendingDevSession, getDevSessionSnapshot);
  useEffect(() => {
    if (!__DEV__ || auth.isLoading) {
      return;
    }
    // Re-read the shared slot: Strict Mode replay must not consume or sign in twice.
    const { replacement, loginReady } = getDevSessionSnapshot();
    if (!replacement) {
      const request = consumePendingDevSession();
      if (request) {
        const next: DevSessionReplacement = {
          request,
          phase: 'teardown',
          epoch: null,
          userId: null,
        };
        setDevSessionReplacement(next);
        report(request.id, 'Replacing account');
        void tearDown(next, auth);
      }
      return;
    }
    if (replacement.phase !== 'login') {
      return;
    }
    if (currentAuthEpoch() !== replacement.epoch) {
      rejectDevSessionRequest(replacement.request.id);
      return;
    }
    if (auth.token || !loginReady) {
      return;
    }
    // isSigningOut stays true until signIn publishes; waiting for false deadlocks.
    const next: DevSessionReplacement = {
      ...replacement,
      phase: 'sign-in',
      epoch: currentAuthEpoch() + 1,
    };
    setDevSessionReplacement(next);
    void admit(next, auth.signIn);
  }, [auth, snapshot]);
  return null;
}

type Admission = {
  userId: string | undefined;
  userIdLoading: boolean;
  userIdError: boolean;
  consentCheckError: boolean;
  isShellReady: boolean;
};

function accountReady(
  replacement: DevSessionReplacement,
  auth: Auth,
  admission: Admission
): boolean {
  return (
    Boolean(auth.token) &&
    !auth.isSigningOut &&
    auth.authEpoch === replacement.epoch &&
    currentAuthEpoch() === replacement.epoch &&
    getActiveTokenSnapshot()?.epoch === replacement.epoch &&
    !isSignOutActive() &&
    !isSignOutTeardownActive() &&
    Boolean(admission.userId) &&
    !admission.userIdLoading &&
    !admission.userIdError &&
    !admission.consentCheckError &&
    admission.isShellReady &&
    (replacement.userId === null || replacement.userId === admission.userId)
  );
}

/** RootLayoutNav calls this hook; it remains the only destination dispatcher. */
export function useDevSessionNavigation(admission: Admission) {
  const auth = useAuth();
  const { replacement } = useSyncExternalStore(subscribePendingDevSession, getDevSessionSnapshot);
  const navigationRef = useNavigationContainerRef();
  const [navigationVersion, setNavigationVersion] = useState(0);
  useEffect(() => {
    if (!__DEV__) {
      return undefined;
    }
    const update = () => {
      setNavigationVersion(version => version + 1);
    };
    update();
    return navigationRef.addListener('state', update);
  }, [navigationRef]);

  useEffect(() => {
    if (
      !__DEV__ ||
      !replacement ||
      getDevSessionSnapshot().replacement !== replacement ||
      (replacement.phase !== 'admitted' && replacement.phase !== 'enqueued')
    ) {
      return;
    }
    if (
      currentAuthEpoch() !== replacement.epoch ||
      isSignOutActive() ||
      isSignOutTeardownActive() ||
      getActiveTokenSnapshot()?.epoch !== replacement.epoch ||
      (replacement.userId !== null && admission.userId !== replacement.userId) ||
      admission.userIdError ||
      admission.consentCheckError ||
      (replacement.phase === 'admitted' && getPendingDeepLinkRequestId() !== replacement.request.id)
    ) {
      rejectDevSessionRequest(replacement.request.id);
      return;
    }
    if (replacement.phase !== 'enqueued' || !accountReady(replacement, auth, admission)) {
      return;
    }
    // A state event only schedules this passive check. Dispatch and navigate return are not commits.
    if (
      isDevSessionDestinationCommitted(navigationRef.current?.getRootState(), replacement.request)
    ) {
      clearTimeout(commitTimeout);
      setDevSessionReplacement(null);
      report(replacement.request.id, 'Destination committed');
    }
  }, [replacement, auth, admission, navigationRef, navigationVersion]);

  return useCallback(
    (href: string, requestId: number | null): string | null => {
      // Old and ordinary hrefs have no development marker and remain supported.
      if (requestId === null) {
        const waiting = getDevSessionSnapshot();
        // Do not enqueue an old account's ordinary destination during replacement.
        return __DEV__ && (waiting.pending || waiting.replacement) ? null : href;
      }
      const current = getDevSessionSnapshot().replacement;
      if (
        !__DEV__ ||
        current?.request.id !== requestId ||
        current.phase !== 'admitted' ||
        current.request.href !== href ||
        getPendingDeepLinkSnapshot() !== href ||
        !accountReady(current, auth, admission)
      ) {
        return null;
      }
      setDevSessionReplacement({ ...current, phase: 'enqueued', userId: admission.userId ?? null });
      // The timeout reports failure but keeps the slot closed, even across unmount.
      commitTimeout = setTimeout(() => {
        rejectDevSessionRequest(requestId);
      }, 15_000);
      // The marker exists only on the dispatched href, never in the durable destination.
      return `${href}?${DEV_SESSION_MARKER}=${requestId}`;
    },
    [auth, admission]
  );
}
