import { Platform } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { API_BASE_URL } from '@/lib/config';
import { classifyPollResponse } from '@/lib/auth/poll-response';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import {
  buildDeviceAuthPollRequest,
  parseDeviceAuthTokenResponse,
} from '@/lib/auth/native-auth-contract';
import {
  approvedDeviceAuthState,
  type DeviceAuthState,
  errorDeviceAuthState,
  terminalDeviceAuthState,
} from '@/lib/auth/device-auth-state';

const POLL_BASE_INTERVAL_MS = 3000;
const POLL_MAX_INTERVAL_MS = 15_000;
const POLL_OVERALL_TIMEOUT_MS = 5 * 60 * 1000;

export function startDeviceAuthPoll(params: {
  code: string;
  deviceCode: string;
  signal: AbortSignal;
  setState: (updater: (prev: DeviceAuthState) => DeviceAuthState) => void;
  cleanup: () => void;
  startedAt?: number;
}): { cleanup: () => void; pollNow: () => void } {
  const { code, deviceCode, signal, setState, cleanup } = params;

  // A resumed transaction reuses the original start clock so its overall
  // budget does not restart from `Date.now()` and outlive the server code.
  const startedAt = params.startedAt ?? Date.now();
  let retryDelay = POLL_BASE_INTERVAL_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
  let inFlight = false;
  let lastTickStartedAt = 0;

  const scheduleNext = (delay: number) => {
    timeoutId = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    inFlight = true;
    lastTickStartedAt = Date.now();
    try {
      await runTick();
    } finally {
      inFlight = false;
    }
  };

  const runTick = async () => {
    if (Date.now() - startedAt > POLL_OVERALL_TIMEOUT_MS) {
      cleanup();
      setState(previous =>
        errorDeviceAuthState(code, 'Sign-in timed out. Please try again.', previous.verificationUrl)
      );
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/device-auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...buildClientMetadataHeaders() },
        body: JSON.stringify(buildDeviceAuthPollRequest(deviceCode)),
        signal,
      });

      const parsed = await (async () => {
        if (response.status === 429 || response.status >= 500) {
          return null;
        }
        const json = await response.json().catch(() => undefined);
        return parseDeviceAuthTokenResponse(json);
      })();

      if (parsed?.status === 'approved') {
        cleanup();
        if (Platform.OS !== 'android') {
          WebBrowser.dismissAuthSession();
        }
        setState(previous =>
          approvedDeviceAuthState({
            code,
            token: parsed.token,
            refreshToken: parsed.refreshToken,
            expiresIn: parsed.expiresIn,
            previousVerificationUrl: previous.verificationUrl,
          })
        );
        return;
      }

      if (parsed && (parsed.status === 'denied' || parsed.status === 'expired')) {
        cleanup();
        const message = parsed.status === 'denied' ? 'Access denied by user' : 'Code expired';
        const terminalStatus: 'denied' | 'expired' = parsed.status;
        setState(previous =>
          terminalDeviceAuthState({
            status: terminalStatus,
            code,
            error: message,
            previousVerificationUrl: previous.verificationUrl,
          })
        );
        return;
      }

      const outcome = classifyPollResponse(response.status);

      // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
      switch (outcome.status) {
        case 'approved':
        case 'denied':
        case 'expired': {
          cleanup();
          setState(previous =>
            errorDeviceAuthState(
              code,
              'Sign-in failed. Please try again.',
              previous.verificationUrl
            )
          );
          return;
        }
        case 'pending': {
          retryDelay = POLL_BASE_INTERVAL_MS;
          scheduleNext(retryDelay);
          return;
        }
        case 'retry': {
          retryDelay = Math.min(retryDelay * 2, POLL_MAX_INTERVAL_MS);
          scheduleNext(retryDelay);
          return;
        }
        case 'error': {
          cleanup();
          setState(previous =>
            errorDeviceAuthState(code, outcome.message, previous.verificationUrl)
          );
          break;
        }
        // No default
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      cleanup();
      setState(previous =>
        errorDeviceAuthState(code, 'Network error. Please try again.', previous.verificationUrl)
      );
    }
  };

  scheduleNext(retryDelay);

  const pollNow = () => {
    // At most one extra poll per foreground transition: skip when a tick is
    // already in flight or the last tick started under 1 second ago.
    if (inFlight || Date.now() - lastTickStartedAt < 1000) {
      return;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    void tick();
  };

  return {
    cleanup: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    },
    pollNow,
  };
}
