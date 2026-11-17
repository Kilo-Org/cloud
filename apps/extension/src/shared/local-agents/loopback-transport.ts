/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
import { z } from 'zod';
import { LOCAL_AGENT_PROTOCOL_VERSION, parseHubHello, parseIncomingEnvelope } from './envelope';
import type { LocalAgentExtensionHello } from './envelope';
import { createLoopbackHandshake } from './loopback-handshake';
import { LocalAgentDialError } from './transport-types';
import type { LocalAgentDial, LocalAgentFailure, LocalAgentTimers } from './transport-types';

/*
 * Loopback WebSocket transport. The socket itself is injected: the shipped
 * adapter wraps the global `WebSocket`, and tests drive these handlers directly.
 * Frames are JSON text; anything else closes the connection. Frames are
 * processed one at a time so `auth_ok` is verified before `hub.hello` is read.
 */

const HANDSHAKE_TIMEOUT_MS = 10_000;

const challengeSchema = z.object({ nonceH: z.string(), type: z.literal('challenge') });
const authOkSchema = z.object({ mac: z.string(), type: z.literal('auth_ok') });
const frameSchema = z.record(z.string(), z.unknown());

export type LoopbackSocketHandlers = {
  onClose(): void;
  onError(): void;
  onOpen(): void;
  onText(text: string): void;
};

export type LoopbackSocketConnection = {
  close(): void;
  sendText(text: string): void;
};

export type LoopbackSocketConnect = (
  url: string,
  handlers: LoopbackSocketHandlers
) => LoopbackSocketConnection;

const parseFrame = (text: string): Record<string, unknown> | null => {
  try {
    const parsed = frameSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const createLoopbackDial =
  ({
    connectSocket,
    endpoint,
    hello,
    timers,
  }: {
    connectSocket: LoopbackSocketConnect;
    endpoint: { hubId: string; key: string; ws: string };
    hello: LocalAgentExtensionHello;
    timers: LocalAgentTimers;
  }): LocalAgentDial =>
  callbacks => {
    const handshake = createLoopbackHandshake({ hubId: endpoint.hubId, key: endpoint.key });

    if (handshake === null) {
      throw new LocalAgentDialError({ kind: 'auth' }, 'Invalid pairing key.');
    }

    let authenticated = false;
    let disposed = false;
    let ready = false;
    let socket: LoopbackSocketConnection | null = null;
    let timeout: number | null = null;
    let pending: Promise<void> = Promise.resolve();

    const clearHandshakeTimeout = (): void => {
      if (timeout !== null) {
        timers.clearTimeout(timeout);
        timeout = null;
      }
    };

    const fail = (failure: LocalAgentFailure): void => {
      if (disposed) {
        return;
      }

      disposed = true;
      clearHandshakeTimeout();
      socket?.close();
      callbacks.onClosed(failure);
    };

    const armHandshakeTimeout = (): void => {
      clearHandshakeTimeout();
      timeout = timers.setTimeout(() => {
        fail({ kind: 'transport' });
      }, HANDSHAKE_TIMEOUT_MS);
    };

    const handleHandshakeFrame = async (frame: Record<string, unknown>): Promise<void> => {
      const challenge = challengeSchema.safeParse(frame);

      if (challenge.success) {
        const auth = await handshake.acceptChallenge(challenge.data.nonceH);

        if (disposed) {
          return;
        }

        if (auth === null) {
          fail({ kind: 'protocol' });

          return;
        }

        socket?.sendText(JSON.stringify(auth));

        return;
      }

      const authOk = authOkSchema.safeParse(frame);

      if (authOk.success) {
        const verified = await handshake.acceptAuthOk(authOk.data.mac);

        if (disposed) {
          return;
        }

        if (!verified) {
          fail({ kind: 'auth' });

          return;
        }

        authenticated = true;

        return;
      }

      const hubHello = parseHubHello(frame);

      if (hubHello === null) {
        fail({ kind: 'protocol' });

        return;
      }

      // Hub.hello before auth_ok would let an unauthenticated peer speak for the hub.
      if (!authenticated || !hubHello.protocol.includes(LOCAL_AGENT_PROTOCOL_VERSION)) {
        fail({ kind: 'protocol' });

        return;
      }

      socket?.sendText(JSON.stringify(hello));
      ready = true;
      clearHandshakeTimeout();
      callbacks.onReady();
    };

    const processFrame = async (text: string): Promise<void> => {
      if (disposed) {
        return;
      }

      const frame = parseFrame(text);

      if (frame === null) {
        fail({ kind: 'protocol' });

        return;
      }

      if (!ready) {
        await handleHandshakeFrame(frame);

        return;
      }

      const envelope = parseIncomingEnvelope(frame);

      if (envelope === null) {
        fail({ kind: 'protocol' });

        return;
      }

      callbacks.onEnvelope(envelope);
    };

    socket = connectSocket(endpoint.ws, {
      onClose: () => {
        fail({ kind: 'transport' });
      },
      onError: () => {
        fail({ kind: 'transport' });
      },
      onOpen: () => {
        armHandshakeTimeout();
      },
      onText: text => {
        const previous = pending;
        pending = (async (): Promise<void> => {
          try {
            await previous;
            await processFrame(text);
          } catch {
            fail({ kind: 'transport' });
          }
        })();
      },
    });

    return {
      close: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        clearHandshakeTimeout();
        socket?.close();
      },
      send: envelope => {
        if (disposed) {
          return;
        }

        socket?.sendText(JSON.stringify(envelope));
      },
    };
  };
