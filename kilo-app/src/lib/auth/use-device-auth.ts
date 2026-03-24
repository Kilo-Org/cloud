import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE_URL } from '@/lib/config';

type DeviceAuthStatus = 'idle' | 'pending' | 'approved' | 'denied' | 'expired' | 'error';

interface DeviceAuthState {
  status: DeviceAuthStatus;
  code: string | undefined;
  token: string | undefined;
  error: string | undefined;
  verificationUrl: string | undefined;
}

type DeviceAuthResult = DeviceAuthState & {
  start: () => Promise<void>;
  cancel: () => void;
  openBrowser: () => Promise<void>;
};

const POLL_INTERVAL_MS = 3000;

export function useDeviceAuth(): DeviceAuthResult {
  const [state, setState] = useState<DeviceAuthState>({
    status: 'idle',
    code: undefined,
    token: undefined,
    error: undefined,
    verificationUrl: undefined,
  });

  const intervalReference = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const abortReference = useRef<AbortController | undefined>(undefined);

  const cleanup = useCallback(() => {
    if (intervalReference.current) {
      clearInterval(intervalReference.current);
      intervalReference.current = undefined;
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
      const tick = async () => {
        try {
          const response = await fetch(`${API_BASE_URL}/api/device-auth/codes/${code}`, {
            signal: abort.signal,
          });

          switch (response.status) {
            case 200: {
              const data = (await response.json()) as { token: string };
              cleanup();
              setState(previous => ({
                status: 'approved',
                code,
                token: data.token,
                error: undefined,
                verificationUrl: previous.verificationUrl,
              }));
              break;
            }
            case 403: {
              cleanup();
              setState(previous => ({
                status: 'denied',
                code,
                token: undefined,
                error: 'Access denied by user',
                verificationUrl: previous.verificationUrl,
              }));
              break;
            }
            case 410: {
              cleanup();
              setState(previous => ({
                status: 'expired',
                code,
                token: undefined,
                error: 'Code expired',
                verificationUrl: previous.verificationUrl,
              }));
              break;
            }
            // No default
          }
          // 202 = still pending, continue polling
        } catch (error: unknown) {
          if (error instanceof Error && error.name === 'AbortError') return;
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

      intervalReference.current = setInterval(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    },
    [cleanup]
  );

  const start = useCallback(async () => {
    cleanup();
    setState({
      status: 'pending',
      code: undefined,
      token: undefined,
      error: undefined,
      verificationUrl: undefined,
    });

    try {
      const response = await fetch(`${API_BASE_URL}/api/device-auth/codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

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

      setState({
        status: 'pending',
        code: data.code,
        token: undefined,
        error: undefined,
        verificationUrl: data.verificationUrl,
      });

      const abort = new AbortController();
      abortReference.current = abort;
      poll(data.code, abort);

      await WebBrowser.openAuthSessionAsync(data.verificationUrl);
    } catch {
      setState({
        status: 'error',
        code: undefined,
        token: undefined,
        error: 'Failed to start sign in. Please try again.',
        verificationUrl: undefined,
      });
    }
  }, [cleanup, poll]);

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
      await WebBrowser.openAuthSessionAsync(state.verificationUrl);
    }
  }, [state.verificationUrl]);

  return { ...state, start, cancel, openBrowser };
}
