import type {
  ControlLogCredentialsFrame,
  ControlPlaneWrapperFrame,
} from '../../../src/shared/control-plane-protocol.js';
import { isRecord } from '../../../src/shared/kilo-event.js';

export const CONTROL_LOG_REFRESH_WINDOW_MS = 60 * 60 * 1000;

const RESPONSE_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

export type ControlLogUploadCredential = {
  token: string;
  /** Wall-clock expiry in milliseconds. */
  expiresAt: number;
};

/** What both uploaders read; they never hold a token of their own. */
export type ControlLogUploadCredentialSource = {
  current(): ControlLogUploadCredential | undefined;
  /** A request using `token` was rejected; true means retrying is worthwhile. */
  rejected(token: string): Promise<boolean>;
};

export type ControlLogUploadAuth = ControlLogUploadCredentialSource & {
  /** The socket is authenticated; request a credential bound to it. */
  connected(): void;
  disconnected(): void;
  /** Called on each heartbeat to renew once less than the window remains. */
  tick(): void;
  receive(frame: ControlLogCredentialsFrame): void;
  stop(): void;
};

type Options = {
  initialGrant?: string;
  send: (frame: ControlPlaneWrapperFrame) => void;
  now?: () => number;
  log?: (message: string) => void;
  refreshWindowMs?: number;
  responseTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
};

function grantExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!isRecord(parsed)) return undefined;
    const exp = parsed.exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Owns the diagnostics upload credential for a wrapper process. The launch grant
 * is retained as identity proof; renewal travels over the existing authenticated
 * socket and is retried a bounded number of times. Uploaders read `current()`, so
 * the JSON diagnostics and archive paths always rotate together.
 */
export function createControlLogUploadAuth(options: Options): ControlLogUploadAuth {
  const now = options.now ?? Date.now;
  const refreshWindowMs = options.refreshWindowMs ?? CONTROL_LOG_REFRESH_WINDOW_MS;
  const responseTimeoutMs = options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const proof = options.initialGrant;
  const initialExpiry = proof === undefined ? undefined : grantExpiryMs(proof);

  let credentials: ControlLogUploadCredential | undefined =
    proof !== undefined && initialExpiry !== undefined
      ? { token: proof, expiresAt: initialExpiry }
      : undefined;
  let isConnected = false;
  let stopped = false;
  let generation = 0;
  let refreshing: Promise<boolean> | undefined;
  let refreshingGeneration: number | undefined;
  let waiter: ((received: boolean) => void) | undefined;
  /** The current token a server already rejected; withheld until replaced. */
  let rejectedToken: string | undefined;

  function settleWaiter(received: boolean): void {
    const finish = waiter;
    waiter = undefined;
    finish?.(received);
  }

  function waitForCredentials(): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (received: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (waiter === finish) waiter = undefined;
        resolve(received);
      };
      const timer = setTimeout(() => finish(false), responseTimeoutMs);
      timer.unref?.();
      waiter = finish;
    });
  }

  async function refreshLoop(force: boolean): Promise<boolean> {
    const before = credentials?.token;
    const startedGeneration = generation;
    const attempts = retryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isConnected || stopped || generation !== startedGeneration) return false;
      if (attempt > 0) {
        const delay = retryDelaysMs[attempt - 1] ?? 0;
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (!isConnected || stopped || generation !== startedGeneration) return false;
      }
      if (force) {
        if (
          credentials !== undefined &&
          credentials.token !== before &&
          credentials.expiresAt - now() > refreshWindowMs
        ) {
          return true;
        }
      } else if (credentials !== undefined && credentials.expiresAt - now() > refreshWindowMs) {
        return true;
      }
      options.send({ type: 'logs.refresh', grant: proof ?? '' });
      if (await waitForCredentials()) {
        if (generation === startedGeneration) return true;
        return false;
      }
    }
    return false;
  }

  function ensureRefresh(force: boolean): Promise<boolean> {
    if (proof === undefined || !isConnected || stopped) return Promise.resolve(false);
    if (refreshing !== undefined && refreshingGeneration === generation) return refreshing;
    if (!force && credentials && credentials.expiresAt - now() > refreshWindowMs) {
      return Promise.resolve(true);
    }
    const flightGeneration = generation;
    const flight = refreshLoop(force)
      .catch(() => false)
      .finally(() => {
        if (refreshing === flight) {
          refreshing = undefined;
          refreshingGeneration = undefined;
        }
      });
    refreshing = flight;
    refreshingGeneration = flightGeneration;
    return flight;
  }

  return {
    current() {
      if (stopped || credentials === undefined) return undefined;
      // An expired or rejected credential is not useful over HTTP; wait for
      // the replacement instead of repeating the same refused request.
      if (credentials.expiresAt <= now()) return undefined;
      if (credentials.token === rejectedToken) return undefined;
      return credentials;
    },
    rejected(token) {
      if (stopped) return Promise.resolve(false);
      if (credentials === undefined) return ensureRefresh(true);
      if (token !== credentials.token) return Promise.resolve(true);
      // Withhold this bearer immediately, before the renewal settles, so a
      // periodic upload cannot repeat a request the server already rejected.
      rejectedToken = token;
      if (!isConnected) return Promise.resolve(false);
      return ensureRefresh(true).then(refreshed => {
        if (!refreshed) options.log?.('control-plane log upload authorization refresh failed');
        return refreshed;
      });
    },
    connected() {
      if (stopped) return;
      isConnected = true;
      generation += 1;
      refreshing = undefined;
      refreshingGeneration = undefined;
      settleWaiter(false);
      void ensureRefresh(true);
    },
    disconnected() {
      isConnected = false;
      generation += 1;
      refreshing = undefined;
      refreshingGeneration = undefined;
      settleWaiter(false);
    },
    tick() {
      if (!isConnected || stopped) return;
      const rejected = credentials !== undefined && credentials.token === rejectedToken;
      if (
        rejected ||
        credentials === undefined ||
        credentials.expiresAt - now() <= refreshWindowMs
      ) {
        void ensureRefresh(rejected || credentials === undefined);
      }
    },
    receive(frame) {
      if (!isConnected || stopped) return;
      if (!Number.isFinite(frame.expiresAt) || frame.expiresAt <= 0) return;
      if (frame.grant !== rejectedToken) rejectedToken = undefined;
      credentials = { token: frame.grant, expiresAt: frame.expiresAt };
      settleWaiter(true);
    },
    stop() {
      stopped = true;
      isConnected = false;
      generation += 1;
      refreshing = undefined;
      refreshingGeneration = undefined;
      settleWaiter(false);
    },
  };
}
