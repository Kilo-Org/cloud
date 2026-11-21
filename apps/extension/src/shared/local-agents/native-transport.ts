/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { LOCAL_AGENT_PROTOCOL_VERSION, parseHubHello, parseIncomingEnvelope } from './envelope';
import type { LocalAgentExtensionHello } from './envelope';
import { LocalAgentDialError } from './transport-types';
import type { LocalAgentDial, LocalAgentFailure, LocalAgentTimers } from './transport-types';

/*
 * Native messaging transport. The browser starts the hub through
 * `runtime.connectNative`; framing (4-byte little-endian length + UTF-8 JSON)
 * belongs to the browser, so this layer only speaks envelopes. A missing or
 * forbidden host becomes `host_missing` so the settings section can explain it.
 */

export const NATIVE_MESSAGING_HOST_NAME = 'ai.kilo.browser_host';

const NATIVE_HANDSHAKE_TIMEOUT_MS = 10_000;

export type NativeMessagingPort = {
  disconnect(): void;
  postMessage(message: unknown): void;
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (message: unknown) => void): void };
};

export type NativeMessagingRuntime = {
  connectNative?: (hostName: string) => NativeMessagingPort;
  lastError?: { message?: string };
};

export const classifyNativeMessagingError = (message: string): LocalAgentFailure => {
  if (/specified native messaging host not found|no such native application/iu.test(message)) {
    return { kind: 'host_missing', reason: 'not_installed' };
  }

  if (/forbidden|access to the specified native messaging host/iu.test(message)) {
    return { kind: 'host_missing', reason: 'permission_denied' };
  }

  return { kind: 'transport' };
};

export const createNativeDial =
  ({
    hello,
    runtime,
    timers,
  }: {
    hello: LocalAgentExtensionHello;
    runtime: NativeMessagingRuntime;
    timers: LocalAgentTimers;
  }): LocalAgentDial =>
  callbacks => {
    const { connectNative } = runtime;

    if (connectNative === undefined) {
      throw new LocalAgentDialError(
        { kind: 'host_missing', reason: 'permission_denied' },
        'Native messaging is not available.'
      );
    }

    let opened: NativeMessagingPort | null = null;

    try {
      opened = connectNative(NATIVE_MESSAGING_HOST_NAME);
    } catch (error) {
      throw new LocalAgentDialError(
        classifyNativeMessagingError(error instanceof Error ? error.message : ''),
        'Native host unavailable.'
      );
    }

    if (opened === null) {
      throw new LocalAgentDialError({ kind: 'transport' }, 'Native host did not open a port.');
    }

    const port: NativeMessagingPort = opened;
    let disposed = false;
    let ready = false;
    let deadline: number | null = null;

    const clearDeadline = (): void => {
      if (deadline !== null) {
        timers.clearTimeout(deadline);
        deadline = null;
      }
    };

    const fail = (failure: LocalAgentFailure): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      clearDeadline();
      port.disconnect();
      callbacks.onClosed(failure);
    };

    // A silent host must not leave the endpoint in `handshaking` forever.
    deadline = timers.setTimeout(() => {
      fail({ kind: 'transport' });
    }, NATIVE_HANDSHAKE_TIMEOUT_MS);

    port.onMessage.addListener((message: unknown) => {
      if (disposed) {
        return;
      }

      const hubHello = parseHubHello(message);

      if (hubHello !== null) {
        if (ready || !hubHello.protocol.includes(LOCAL_AGENT_PROTOCOL_VERSION)) {
          fail({ kind: 'protocol' });

          return;
        }

        port.postMessage(hello);
        ready = true;
        clearDeadline();
        callbacks.onReady();

        return;
      }

      if (!ready) {
        fail({ kind: 'protocol' });

        return;
      }

      const envelope = parseIncomingEnvelope(message);

      if (envelope === null) {
        fail({ kind: 'protocol' });

        return;
      }

      callbacks.onEnvelope(envelope);
    });

    port.onDisconnect.addListener(() => {
      if (disposed) {
        return;
      }

      // Reading lastError clears Chrome's unchecked-error warning for the port.
      disposed = true;
      clearDeadline();
      callbacks.onClosed(classifyNativeMessagingError(runtime.lastError?.message ?? ''));
    });

    return {
      close: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        clearDeadline();
        port.disconnect();
      },
      send: envelope => {
        if (disposed) {
          return;
        }

        port.postMessage(envelope);
      },
    };
  };
