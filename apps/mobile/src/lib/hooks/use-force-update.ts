import * as Application from 'expo-application';
import { onlineManager } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { API_BASE_URL } from '@/lib/config';
import { resolveForceUpdateState } from '@/lib/force-update-policy';
import {
  clearForceUpdateSignal,
  getForceUpdateSignalSnapshot,
  subscribeToForceUpdateSignal,
} from '@/lib/force-update-signal';

const CHECK_SPACING_MS = 30_000;
const CHECK_TIMEOUT_MS = 5000;

export function useForceUpdate() {
  const [pollRequired, setPollRequired] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const lastCheckAtRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);

  const signalRequired = useSyncExternalStore(
    subscribeToForceUpdateSignal,
    getForceUpdateSignalSnapshot
  );

  const check = useCallback(async () => {
    if (Date.now() - lastCheckAtRef.current < CHECK_SPACING_MS) {
      return;
    }
    // Single-flight: abort any in-flight check before starting a new one.
    inFlightRef.current?.abort();

    const controller = new AbortController();
    inFlightRef.current = controller;
    lastCheckAtRef.current = Date.now();

    const timeout = setTimeout(() => {
      controller.abort();
    }, CHECK_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE_URL}/api/app/min-version`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const data = await response.json().catch(() => undefined);
      const updateRequired = resolveForceUpdateState(
        { ok: response.ok, data },
        Application.nativeApplicationVersion,
        Platform.OS === 'ios' ? 'ios' : 'android'
      );

      setPollRequired(updateRequired);
      setIsChecking(false);
      if (!updateRequired) {
        clearForceUpdateSignal();
      }
    } catch {
      // Fail open — the client fails open on its own network error; the server
      // middleware (G1) is the fail-closed half. Do not clear the signal here.
      setIsChecking(false);
    } finally {
      clearTimeout(timeout);
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void check();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [check]);

  useEffect(
    () =>
      onlineManager.subscribe(online => {
        if (online) {
          void check();
        }
      }),
    [check]
  );

  const updateRequired = pollRequired || signalRequired;
  return { updateRequired, isChecking };
}
