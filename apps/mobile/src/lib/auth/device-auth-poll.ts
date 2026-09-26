import { i18n } from '@/i18n';
import { API_BASE_URL } from '@/lib/config';
import { type AuthBrowserKind, dismissAuthBrowser } from '@/lib/auth/auth-browser';
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
  startedAt?: number;
}): DeviceAuthPollHandle {
  const { code, deviceCode, signal, setState, cleanup, browserKind } = params;

  // A resumed transaction reuses the original start clock so its overall
  // budget does not restart from `Date.now()` and outlive the server code.
  const startedAt = params.startedAt ?? Date.now();
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
    if (Date.now() - startedAt >= POLL_OVERALL_TIMEOUT_MS) {
      cleanup();
      setState(previous =>
        errorDeviceAuthState(code, i18n.t('authErrors.signInTimedOut'), previous.verificationUrl)
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
        dismissAuthBrowser(browserKind);
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
        const message =
          parsed.status === 'denied'
            ? i18n.t('authErrors.accessDeniedByUser')
            : i18n.t('authErrors.codeExpired');
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

      const outcome = classifyPollResponse(response.status, response.headers.get('retry-after'));

      // eslint-disable-next-line typescript-eslint/switch-exhaustiveness-check
      switch (outcome.status) {
        case 'approved':
        case 'denied':
        case 'expired': {
          cleanup();
          setState(previous =>
            errorDeviceAuthState(code, i18n.t('authErrors.invalidToken'), previous.verificationUrl)
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
          // A throttled poll waits as long as the server asked, never less
          // than our own backoff, and never past the overall poll budget: the
          // wait is capped by the time left, so a Retry-After longer than the
          // remaining budget cannot schedule a tick after the budget. The
          // boundary check above is inclusive so a wait capped to exactly the
          // remaining time times out on that tick instead of polling again.
          const wait = Math.max(retryDelay, outcome.retryAfterMs ?? 0);
          const remaining = POLL_OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
          const delay = Math.min(wait, Math.max(0, remaining));
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
      // A transient network failure must not discard an approval the browser
      // may already have delivered: back off like a throttled poll and keep
      // retrying within the overall budget. Our own backoff stays bypassable
      // by a foreground poll, so a resume can retry promptly. The boundary
      // check on a later tick surfaces the timeout if connectivity never
      // returns, so the 5-minute budget still bounds the flow. The wait is
      // capped by the time left so it cannot schedule a tick past the budget.
      retryDelay = Math.min(retryDelay * 2, POLL_MAX_INTERVAL_MS);
      const remaining = POLL_OVERALL_TIMEOUT_MS - (Date.now() - startedAt);
      scheduleNext(Math.min(retryDelay, Math.max(0, remaining)));
    }
  };

  scheduleNext(retryDelay);

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
