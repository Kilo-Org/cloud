import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { i18n } from '@/i18n';
import { API_BASE_URL, WEB_BASE_URL } from '@/lib/config';
import { getDeviceAuth429Message } from '@/lib/auth/poll-response';
import { parseDeviceAuthCodeResponse } from '@/lib/auth/native-auth-contract';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import {
  type DeviceAuthState,
  errorDeviceAuthState,
  idleDeviceAuthState,
  pendingDeviceAuthState,
} from '@/lib/auth/device-auth-state';
import { startDeviceAuthPoll } from '@/lib/auth/device-auth-poll';
import {
  clearPendingExternalAuth,
  readPendingExternalAuth,
  writePendingExternalAuth,
} from '@/lib/auth/pending-external-auth';

type DeviceAuthResult = DeviceAuthState & {
  start: (mode?: 'signin' | 'signup' | 'sso', ssoEmail?: string) => Promise<void>;
  cancel: () => void;
  openBrowser: () => Promise<void>;
};

const START_TIMEOUT_MS = 15_000;

// Android has no native auth session; expo-web-browser's polyfill keeps
// module-level state that can get stuck and reject every future call
// (KILO-APP-22). We poll the server for approval instead of relying on a
// redirect, so a plain browser open is all Android needs.
async function openAuthBrowser(url: string) {
  await (Platform.OS === 'android'
    ? WebBrowser.openBrowserAsync(url)
    : WebBrowser.openAuthSessionAsync(url));
}

export function useDeviceAuth(): DeviceAuthResult {
  const [state, setState] = useState<DeviceAuthState>(idleDeviceAuthState());

  const timeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortReference = useRef<AbortController | undefined>(undefined);
  const pollCleanupRef = useRef<{ cleanup: () => void; pollNow: () => void } | undefined>(
    undefined
  );
  // The device secret is stored ONLY in a ref — never in React state, never in
  // a URL, never in the clipboard. It is consumed in the POST body only.
  const deviceCodeReference = useRef<string | undefined>(undefined);
  // Monotonic epoch bumped at the top of every start(). The mount restore read
  // captures it before its async SecureStore read and bails when it changed, so
  // a live start() that begins while the read is in flight always wins and the
  // restore never clobbers it or starts a second poll.
  const flowEpochRef = useRef(0);

  const cleanup = useCallback(() => {
    if (timeoutReference.current) {
      clearTimeout(timeoutReference.current);
      timeoutReference.current = undefined;
    }
    if (abortReference.current) {
      abortReference.current.abort();
      abortReference.current = undefined;
    }
    if (pollCleanupRef.current) {
      pollCleanupRef.current.cleanup();
      pollCleanupRef.current = undefined;
    }
    deviceCodeReference.current = undefined;
    void clearPendingExternalAuth();
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  // Android opens a plain browser and returns via AppState 'active', so poll
  // once immediately on foreground while pending — bounded by pollNow (one per
  // foreground, never within 1 s of the previous poll).
  useEffect(() => {
    const handleChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') {
        return;
      }
      if (state.status !== 'pending') {
        return;
      }
      pollCleanupRef.current?.pollNow();
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, [state.status]);

  // Restore a pending transaction that survived process death. The record is
  // read once on mount; an absent or expired record leaves the screen idle.
  useEffect(() => {
    let cancelled = false;

    async function restorePending() {
      const epochAtRead = flowEpochRef.current;
      const result = await readPendingExternalAuth();
      if (cancelled || flowEpochRef.current !== epochAtRead) {
        return;
      }
      if (result.kind === 'stale') {
        await clearPendingExternalAuth();
        return;
      }
      if (result.kind === 'none') {
        return;
      }
      const record = result.record;
      deviceCodeReference.current = record.deviceCode;
      setState(pendingDeviceAuthState(record.userCode, record.verificationUrl, true));
      const abort = new AbortController();
      abortReference.current = abort;
      pollCleanupRef.current = startDeviceAuthPoll({
        code: record.userCode,
        deviceCode: record.deviceCode,
        signal: abort.signal,
        setState,
        cleanup,
        startedAt: record.startedAt,
      });
    }

    void restorePending();
    return () => {
      cancelled = true;
    };
  }, [cleanup]);

  const start = useCallback(
    async (mode?: 'signin' | 'signup' | 'sso', ssoEmail?: string) => {
      flowEpochRef.current += 1;
      cleanup();
      setState(pendingDeviceAuthState(undefined, undefined));

      // Held in abortReference so cancel() can abort the in-flight POST too —
      // otherwise a request resolving after Cancel would overwrite the idle
      // state, start polling, and open the browser anyway.
      const startAbort = new AbortController();
      abortReference.current = startAbort;
      const startTimeout = setTimeout(() => {
        startAbort.abort();
        setState(
          errorDeviceAuthState(undefined, i18n.t('authErrors.startSignInFailed'), undefined)
        );
      }, START_TIMEOUT_MS);

      try {
        const response = await fetch(`${API_BASE_URL}/api/device-auth/codes?app=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...buildClientMetadataHeaders() },
          signal: startAbort.signal,
        });
        // The timeout guards ONLY the POST. This function stays suspended on
        // `await openAuthBrowser(...)` for as long as the auth sheet is open,
        // so a timer still running past this point would fire mid-sign-in and
        // stomp the live pending/idle state with a bogus error.
        clearTimeout(startTimeout);

        // Cancel can race request completion — if it landed while awaiting,
        // the user is back on the idle screen; don't revive the flow.
        if (startAbort.signal.aborted) {
          return;
        }

        if (!response.ok) {
          if (response.status === 429) {
            const body = (await response.json().catch(() => undefined)) as
              | { error?: string }
              | undefined;
            const message = getDeviceAuth429Message(body);
            setState(errorDeviceAuthState(undefined, message, undefined));
            return;
          }
          setState(
            errorDeviceAuthState(undefined, i18n.t('authErrors.startSignInFailed'), undefined)
          );
          return;
        }

        const data = parseDeviceAuthCodeResponse(await response.json());
        if (!data) {
          setState(
            errorDeviceAuthState(undefined, i18n.t('authErrors.startSignInFailed'), undefined)
          );
          return;
        }

        const { userCode, deviceCode } = data;

        deviceCodeReference.current = deviceCode;

        // Persist the pending transaction so a process death mid-sign-in can
        // resume it. The device code is a secret, so it lives in SecureStore
        // only (never React state, a URL, or the clipboard).
        void writePendingExternalAuth({
          deviceCode,
          userCode,
          verificationUrl: data.verificationUrl,
          startedAt: Date.now(),
        });

        // Sign-in uses the server-provided verificationUrl which points directly
        // at /device-auth?code=... Sign-up instead routes through the sign-in
        // page with signup=true so the web UI renders the create-account flow;
        // callbackPath then forwards the user to /device-auth?code=... after
        // account creation to complete the device-auth approval. SSO recovery
        // routes through the sign-in page with sso=true and the email so the web
        // SSO page resolves the organization; the organization id is NOT put in
        // the URL — it stays in client state and as a Sentry tag.
        let browserUrl = data.verificationUrl;
        if (mode === 'signup') {
          browserUrl = `${WEB_BASE_URL}/users/sign_in?${new URLSearchParams({
            callbackPath: `/device-auth?code=${userCode}&app=1`,
            signup: 'true',
          }).toString()}`;
        } else if (mode === 'sso') {
          browserUrl = `${WEB_BASE_URL}/users/sign_in?${new URLSearchParams({
            sso: 'true',
            email: ssoEmail ?? '',
            callbackPath: `/device-auth?code=${userCode}&app=1`,
          }).toString()}`;
        }

        setState(pendingDeviceAuthState(userCode, browserUrl));

        const abort = new AbortController();
        abortReference.current = abort;
        pollCleanupRef.current = startDeviceAuthPoll({
          code: userCode,
          deviceCode,
          signal: abort.signal,
          setState,
          cleanup,
        });

        await openAuthBrowser(browserUrl);
      } catch (error: unknown) {
        // An aborted POST is either the 15s start timeout (its callback set
        // the error state already) or an explicit cancel (stays idle) —
        // either way there's nothing more to do here.
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        setState(
          errorDeviceAuthState(undefined, i18n.t('authErrors.startSignInFailed'), undefined)
        );
        void clearPendingExternalAuth();
      } finally {
        clearTimeout(startTimeout);
      }
    },
    [cleanup]
  );

  const cancel = useCallback(() => {
    cleanup();
    setState(idleDeviceAuthState());
  }, [cleanup]);

  const openBrowser = useCallback(async () => {
    if (state.verificationUrl) {
      try {
        await openAuthBrowser(state.verificationUrl);
      } catch {
        setState(previous =>
          errorDeviceAuthState(
            previous.code,
            i18n.t('authErrors.couldNotOpenBrowser'),
            previous.verificationUrl
          )
        );
      }
    }
  }, [state.verificationUrl]);

  return { ...state, start, cancel, openBrowser };
}
