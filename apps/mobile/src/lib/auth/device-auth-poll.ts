import { API_BASE_URL } from '@/lib/config';
import { type AuthBrowserKind, dismissAuthBrowser } from '@/lib/auth/auth-browser';
import { classifyPollResponse } from '@/lib/auth/poll-response';
import { buildClientMetadataHeaders } from '@/lib/client-metadata';
import {
  approvedDeviceAuthState,
  deviceAuthErrorKey,
  type DeviceAuthState,
  errorDeviceAuthState,
  terminalDeviceAuthState,
} from '@/lib/auth/device-auth-state';
import {
  buildDeviceAuthPollRequest,
  parseDeviceAuthTokenResponse,
} from '@/lib/auth/native-auth-contract';

const POLL_BASE_INTERVAL_MS = 3000;
const POLL_MAX_INTERVAL_MS = 15_000;
// The code lifetime to assume when the server's code response names none.
const DEFAULT_CODE_LIFETIME_MS = 5 * 60 * 1000;

/** The `Date.now()` time at which the server's device code expires. */
export function deviceAuthExpiresAt(now: number, expiresInSeconds: number | undefined): number {
  return (
    now + (expiresInSeconds === undefined ? DEFAULT_CODE_LIFETIME_MS : expiresInSeconds * 1000)
  );
}

export type DeviceAuthPollHandle = {
  cleanup: () => void;
  pollNow: () => void;
};

export function startDeviceAuthPoll(params: {
  code: string;
  deviceCode: string;
  signal: AbortSignal;
  setState: (updater: (prev: DeviceAuthState) => DeviceAuthState) => void;
  cleanup: () => void;
  /**
   * The API that opened the verification page. Approval ends the flow without
   * waiting for the page, so the poll closes it with the matching dismissal.
   */
  browserKind: AuthBrowserKind;
  /**
   * When the server's code expires, in `Date.now()` milliseconds (see
   * `deviceAuthExpiresAt`). A resumed transaction passes the stored deadline so
   * its budget does not restart and outlive the server code.
   */
  expiresAt: number;
}): DeviceAuthPollHandle {
  const { code, deviceCode, signal, setState, cleanup, browserKind, expiresAt } = params;

  let retryDelay = POLL_BASE_INTERVAL_MS;
  let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
  let inFlight = false;
  let lastTickStartedAt = 0;
  // The server's own throttle deadline, in `Date.now()` milliseconds. A
  // foreground poll (`pollNow`) must not send a request before it: resuming
  // the app is not the server's permission to poll again. Only a retry that
  // named a `Retry-After` records a deadline; our own backoff stays
  // bypassable so a resume still polls promptly while the server is merely
  // pending. Always at or before the retry timer it was scheduled with, so
  // it is never stale while a timer is pending.
  let throttledUntil = 0;
  // The uncapped `Retry-After` deadline. A tick at the budget's end does not
  // send its final poll while the server still asks the app to wait.
  let retryAfterUntil = 0;

  const timeOut = () => {
    cleanup();
    setState(previous =>
      errorDeviceAuthState(
        code,
        deviceAuthErrorKey('authErrors.signInTimedOut'),
        previous.verificationUrl
      )
    );
  };

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

  // JS timers do not run while the app is in the background, so the first tick
  // after a return can come after the budget. It still sends one poll: the
  // browser may have approved the code while the app was away, and only the
  // server can say so. The budget ends the flow only after that poll.
  const runTick = async () => {
    if (Date.now() >= expiresAt && Date.now() < retryAfterUntil) {
      timeOut();
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
        dismissAuthBrowser(browserKind);
        setState(previous =>
          approvedDeviceAuthState({
            code,
            token: parsed.token,
            refreshToken: parsed.refreshToken,
            expiresIn: parsed.expiresIn,
            previousVerificationUrl: previous.verificationUrl,
            pendingLink: parsed.pendingLink,
          })
        );
        return;
      }

      if (parsed && (parsed.status === 'denied' || parsed.status === 'expired')) {
        cleanup();
        // The banner re-translates denied/expired at render by status; the
        // stored key is the fallback a terminal state still carries.
        const error = deviceAuthErrorKey(
          parsed.status === 'denied' ? 'authErrors.accessDeniedByUser' : 'authErrors.codeExpired'
        );
        const terminalStatus: 'denied' | 'expired' = parsed.status;
        setState(previous =>
          terminalDeviceAuthState({
            status: terminalStatus,
            code,
            error,
            previousVerificationUrl: previous.verificationUrl,
          })
        );
        return;
      }

      const outcome = classifyPollResponse(response.status, response.headers.get('retry-after'));

      // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
      switch (outcome.status) {
        case 'approved':
        case 'denied':
        case 'expired': {
          cleanup();
          setState(previous =>
            errorDeviceAuthState(
              code,
              deviceAuthErrorKey('authErrors.invalidToken'),
              previous.verificationUrl
            )
          );
          return;
        }
        case 'pending': {
          if (Date.now() >= expiresAt) {
            timeOut();
            return;
          }
          retryDelay = POLL_BASE_INTERVAL_MS;
          scheduleNext(Math.min(retryDelay, expiresAt - Date.now()));
          return;
        }
        case 'retry': {
          if (Date.now() >= expiresAt) {
            timeOut();
            return;
          }
          retryDelay = Math.min(retryDelay * 2, POLL_MAX_INTERVAL_MS);
          // A throttled poll waits as long as the server asked, never less
          // than our own backoff, and never past the overall poll budget: the
          // wait is capped by the time left, so a Retry-After longer than the
          // remaining budget cannot schedule a tick after the budget. That tick
          // times out without a poll while the server's wait is still running.
          const wait = Math.max(retryDelay, outcome.retryAfterMs ?? 0);
          const delay = Math.min(wait, expiresAt - Date.now());
          retryAfterUntil = Date.now() + (outcome.retryAfterMs ?? 0);
          // Record the server's deadline for a foreground poll. Capped by the
          // scheduled delay, so a Retry-After longer than the remaining budget
          // never pushes the deadline past the tick that times the poll out.
          throttledUntil = Date.now() + Math.min(outcome.retryAfterMs ?? 0, delay);
          scheduleNext(delay);
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
        errorDeviceAuthState(
          code,
          deviceAuthErrorKey('authErrors.networkError'),
          previous.verificationUrl
        )
      );
    }
  };

  scheduleNext(Math.max(0, Math.min(retryDelay, expiresAt - Date.now())));

  const pollNow = () => {
    // At most one extra poll per foreground transition: skip when a tick is
    // already in flight or the last tick started under 1 second ago.
    if (inFlight || Date.now() - lastTickStartedAt < 1000) {
      return;
    }
    // A foreground transition is not the server's permission to poll again.
    // While a Retry-After throttle is in force, leave the retry timer it was
    // scheduled with in place instead of ticking: the server asked us to wait.
    if (Date.now() < throttledUntil) {
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
