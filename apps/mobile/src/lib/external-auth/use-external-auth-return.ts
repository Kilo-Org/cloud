import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus, Platform } from 'react-native';

/**
 * Tracks an in-flight external-auth launch and invokes `onReturn` once the
 * app returns to the foreground on Android. iOS uses `openAuthSessionAsync`,
 * which resolves on sheet close, so no foreground listener is needed there —
 * callers refetch directly on `'sheet-close'` instead.
 *
 * Extracted from `pr-review-connect-gate.tsx` so every external-auth flow
 * (PR review, security-agent setup, provider connect) shares one
 * implementation of the launch sentinel + AppState listener.
 */
export function useExternalAuthReturn(onReturn: () => void): {
  markLaunched: () => void;
  clearLaunch: () => void;
} {
  const launchedAt = useRef<number | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }
    const handleChange = (nextState: AppStateStatus) => {
      if (nextState !== 'active') {
        return;
      }
      if (launchedAt.current === null) {
        return;
      }
      launchedAt.current = null;
      onReturn();
    };
    const subscription = AppState.addEventListener('change', handleChange);
    return () => {
      subscription.remove();
    };
  }, [onReturn]);

  const markLaunched = useCallback(() => {
    launchedAt.current = Date.now();
  }, []);

  const clearLaunch = useCallback(() => {
    launchedAt.current = null;
  }, []);

  return { markLaunched, clearLaunch };
}
