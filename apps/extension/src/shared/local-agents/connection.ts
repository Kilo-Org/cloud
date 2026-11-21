/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { backoffDelayMs, INITIAL_LOCAL_AGENT_CONNECTION_STATE } from './connection-state';
import type { LocalAgentConnectionState } from './connection-state';
import { buildRpcEnvelope } from './envelope';
import type { LocalAgentIncomingEnvelope } from './envelope';
import { LocalAgentDialError } from './transport-types';
import type {
  LocalAgentDial,
  LocalAgentFailure,
  LocalAgentTimers,
  LocalAgentTransportHandle,
} from './transport-types';

/*
 * One endpoint's connection lifecycle (SPEC transport work): the state union is
 * `off | connecting | handshaking | connected | backoff | host_missing`, every
 * dial carries an attempt number, and callbacks from an older attempt are
 * dropped instead of mutating a newer connection.
 */

const HOST_MISSING_RETRY_MS = 30_000;

export type LocalAgentEndpoint =
  | { endpointId: string; transport: 'native' }
  | { endpointId: string; transport: 'loopback'; hubId: string; ws: string; key: string };

export type LocalAgentConnection = {
  endpoint: LocalAgentEndpoint;
  state(): LocalAgentConnectionState;
  /** Idempotent: live and not-yet-due backoff states are left alone. */
  connect(): void;
  close(): void;
  send(controllerId: string, message: Record<string, unknown>): boolean;
};

export const createLocalAgentConnection = ({
  dial,
  endpoint,
  now,
  onEnvelope,
  onStateChange,
  timers,
}: {
  dial: LocalAgentDial;
  endpoint: LocalAgentEndpoint;
  now: () => number;
  onEnvelope: (envelope: LocalAgentIncomingEnvelope) => void;
  onStateChange: (state: LocalAgentConnectionState) => void;
  timers: LocalAgentTimers;
}): LocalAgentConnection => {
  let attempt = 0;
  let disposed = false;
  let handle: LocalAgentTransportHandle | null = null;
  let retryTimer: number | undefined = undefined;
  let state: LocalAgentConnectionState = INITIAL_LOCAL_AGENT_CONNECTION_STATE;

  const setState = (next: LocalAgentConnectionState): void => {
    state = next;
    onStateChange(next);
  };

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      timers.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const scheduleRetry = (delayMs: number): void => {
    clearRetry();
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delayMs);
  };

  const fail = (failure: LocalAgentFailure): void => {
    handle = null;

    if (failure.kind === 'host_missing') {
      setState({ kind: 'host_missing', reason: failure.reason });
      scheduleRetry(HOST_MISSING_RETRY_MS);

      return;
    }

    const delay = backoffDelayMs(attempt);
    setState({ attempt, kind: 'backoff', until: now() + delay });
    scheduleRetry(delay);
  };

  const connect = (): void => {
    if (disposed) {
      return;
    }

    if (state.kind === 'connecting' || state.kind === 'handshaking' || state.kind === 'connected') {
      return;
    }

    if (state.kind === 'backoff' && state.until > now()) {
      return;
    }

    attempt += 1;
    const current = attempt;
    let ready = false;
    setState({ attempt: current, kind: 'connecting' });

    try {
      handle = dial({
        onClosed: failure => {
          if (disposed || current !== attempt) {
            return;
          }

          fail(failure);
        },
        onEnvelope: envelope => {
          if (disposed || current !== attempt) {
            return;
          }

          onEnvelope(envelope);
        },
        onReady: () => {
          if (disposed || current !== attempt) {
            return;
          }

          ready = true;
          setState({ attempt: current, kind: 'connected' });
        },
      });
    } catch (error) {
      handle = null;

      fail(error instanceof LocalAgentDialError ? error.failure : { kind: 'transport' });

      return;
    }

    // The transport is open and negotiating (`challenge`/`auth`, or `hub.hello`).
    if (!ready && !disposed && current === attempt) {
      setState({ attempt: current, kind: 'handshaking' });
    }
  };

  return {
    close: () => {
      if (disposed) {
        return;
      }

      disposed = true;
      clearRetry();
      handle?.close();
      handle = null;
      setState({ kind: 'off' });
    },
    connect,
    endpoint,
    send: (controllerId, message) => {
      if (state.kind !== 'connected' || handle === null) {
        return false;
      }

      handle.send(buildRpcEnvelope(controllerId, message));

      return true;
    },
    state: () => state,
  };
};
