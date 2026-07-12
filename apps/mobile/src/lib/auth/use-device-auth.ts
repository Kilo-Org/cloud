import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { API_BASE_URL, WEB_BASE_URL } from '@/lib/config';
import { classifyPollResponse } from '@/lib/auth/poll-response';

type DeviceAuthStatus = 'idle' | 'pending' | 'approved' | 'denied' | 'expired' | 'error';

type DeviceAuthState = {
  status: DeviceAuthStatus;
  code: string | undefined;
  token: string | undefined;
  error: string | undefined;
  verificationUrl: string | undefined;
};

type DeviceAuthResult = DeviceAuthState & {
  start: (mode?: 'signin' | 'signup') => Promise<void>;
  cancel: () => void;
  openBrowser: () => Promise<void>;
};

const POLL_BASE_INTERVAL_MS = 3000;
const POLL_MAX_INTERVAL_MS = 15_000;
// Safety net in case the server never returns a terminal status (200/403/410) —
// without this a dropped code would poll forever.
const POLL_OVERALL_TIMEOUT_MS = 5 * 60 * 1000;
// expo/RN's Hermes build bundled with this Expo SDK does not reliably expose
// AbortSignal.timeout, so we use the AbortController + setTimeout pattern
// instead of relying on it.
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
  const [state, setState] = useState<DeviceAuthState>({
    status: 'idle',
    code: undefined,
    token: undefined,
    error: undefined,
    verificationUrl: undefined,
  });

  const timeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortReference = useRef<AbortController | undefined>(undefined);

  const cleanup = useCallback(() => {
    if (timeoutReference.current) {
      clearTimeout(timeoutReference.current);
      timeoutReference.current = undefined;
    }
    if (abortReference.current) {
      abortReference.current.abort();
      abortReference.current = undefined;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  const poll = useCallback(
    (code: string, abort: AbortController) => {
      const startedAt = Date.now();
      let retryDelay = POLL_BASE_INTERVAL_MS;

      const scheduleNext = (delay: number) => {
        timeoutReference.current = setTimeout(() => {
          void tick();
        }, delay);
      };

      const tick = async () => {
        if (Date.now() - startedAt > POLL_OVERALL_TIMEOUT_MS) {
          cleanup();
          setState(previous => ({
            status: 'error',
            code,
            token: undefined,
            error: 'Sign-in timed out. Please try again.',
            verificationUrl: previous.verificationUrl,
          }));
          return;
        }

        try {
          const response = await fetch(`${API_BASE_URL}/api/device-auth/codes/${code}`, {
            signal: abort.signal,
          });
          const outcome = classifyPollResponse(response.status);

          switch (outcome.status) {
            case 'approved': {
              const data = (await response.json()) as { token: string };
              cleanup();
              // dismissAuthSession closes the iOS ASWebAuthenticationSession sheet. On
              // Android we open a plain custom tab (no auth session) and the native module
              // has no dismissBrowser, so calling it there is at best a no-op and can throw.
              if (Platform.OS !== 'android') {
                WebBrowser.dismissAuthSession();
              }
              setState(previous => ({
                status: 'approved',
                code,
                token: data.token,
                error: undefined,
                verificationUrl: previous.verificationUrl,
              }));
              return;
            }
            case 'denied':
            case 'expired':
            case 'error': {
              cleanup();
              setState(previous => ({
                status: outcome.status,
                code,
                token: undefined,
                error: outcome.message,
                verificationUrl: previous.verificationUrl,
              }));
              return;
            }
            case 'retry': {
              retryDelay = Math.min(retryDelay * 2, POLL_MAX_INTERVAL_MS);
              scheduleNext(retryDelay);
              return;
            }
            case 'pending': {
              retryDelay = POLL_BASE_INTERVAL_MS;
              scheduleNext(retryDelay);
              break;
            }
            // No default
          }
        } catch (error: unknown) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }
          cleanup();
          setState(previous => ({
            status: 'error',
            code,
            token: undefined,
            error: 'Network error. Please try again.',
            verificationUrl: previous.verificationUrl,
          }));
        }
      };

      scheduleNext(retryDelay);
    },
    [cleanup]
  );

  const start = useCallback(
    async (mode?: 'signin' | 'signup') => {
      cleanup();
      setState({
        status: 'pending',
        code: undefined,
        token: undefined,
        error: undefined,
        verificationUrl: undefined,
      });

      // Held in abortReference so cancel() can abort the in-flight POST too —
      // otherwise a request resolving after Cancel would overwrite the idle
      // state, start polling, and open the browser anyway.
      const startAbort = new AbortController();
      abortReference.current = startAbort;
      const startTimeout = setTimeout(() => {
        startAbort.abort();
        setState({
          status: 'error',
          code: undefined,
          token: undefined,
          error: 'Failed to start sign in. Please try again.',
          verificationUrl: undefined,
        });
      }, START_TIMEOUT_MS);

      try {
        const response = await fetch(`${API_BASE_URL}/api/device-auth/codes?app=1`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
          setState({
            status: 'error',
            code: undefined,
            token: undefined,
            error: 'Failed to start sign in. Please try again.',
            verificationUrl: undefined,
          });
          return;
        }

        const data = (await response.json()) as {
          code: string;
          verificationUrl: string;
        };

        // Sign-in uses the server-provided verificationUrl which points directly
        // at /device-auth?code=... Sign-up instead routes through the sign-in
        // page with signup=true so the web UI renders the create-account flow;
        // callbackPath then forwards the user to /device-auth?code=... after
        // account creation to complete the device-auth approval.
        const browserUrl =
          mode === 'signup'
            ? `${WEB_BASE_URL}/users/sign_in?${new URLSearchParams({
                callbackPath: `/device-auth?code=${data.code}&app=1`,
                signup: 'true',
              }).toString()}`
            : data.verificationUrl;

        setState({
          status: 'pending',
          code: data.code,
          token: undefined,
          error: undefined,
          verificationUrl: browserUrl,
        });

        const abort = new AbortController();
        abortReference.current = abort;
        poll(data.code, abort);

        await openAuthBrowser(browserUrl);
      } catch (error: unknown) {
        // An aborted POST is either the 15s start timeout (its callback set
        // the error state already) or an explicit cancel (stays idle) —
        // either way there's nothing more to do here.
        if (error instanceof Error && error.name === 'AbortError') {
          return;
        }
        setState({
          status: 'error',
          code: undefined,
          token: undefined,
          error: 'Failed to start sign in. Please try again.',
          verificationUrl: undefined,
        });
      } finally {
        clearTimeout(startTimeout);
      }
    },
    [cleanup, poll]
  );

  const cancel = useCallback(() => {
    cleanup();
    setState({
      status: 'idle',
      code: undefined,
      token: undefined,
      error: undefined,
      verificationUrl: undefined,
    });
  }, [cleanup]);

  const openBrowser = useCallback(async () => {
    if (state.verificationUrl) {
      try {
        await openAuthBrowser(state.verificationUrl);
      } catch {
        setState(previous => ({
          status: 'error',
          code: previous.code,
          token: undefined,
          error: 'Could not open browser. Please try again.',
          verificationUrl: previous.verificationUrl,
        }));
      }
    }
  }, [state.verificationUrl]);

  return { ...state, start, cancel, openBrowser };
}
