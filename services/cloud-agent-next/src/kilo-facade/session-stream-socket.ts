import { withTimeout } from '@kilocode/worker-utils';
import type { SandboxSessionV2 } from '../control-plane/session/session-do.js';
import { logger } from '../logger.js';
import { withDORetry } from '../utils/do-retry.js';

/**
 * The DO-to-DO `/stream` opener shared by the Cloud Agent system feed and the
 * native `/event` live tail. A Durable Object uses a WebSocket as a client to
 * another Durable Object: the returned socket is the client end of the session
 * DO's hibernatable `/stream` socket.
 */
export type SessionStreamSocket = { close(): void };

export type SessionStreamOpenResult =
  | { kind: 'open'; socket: SessionStreamSocket }
  | { kind: 'stopped' }
  | { kind: 'unavailable' };

export type OpenSessionStreamSocketParams = {
  stub: DurableObjectStub<SandboxSessionV2>;
  search: string;
  operationName: string;
  onMessage: (payload: unknown) => void;
  onEnd: () => void;
};

const OPEN_DEADLINE_MS = 5_000;

export async function openSessionStreamSocket(
  params: OpenSessionStreamSocketParams
): Promise<SessionStreamOpenResult> {
  const connect = withDORetry(
    () => params.stub,
    current =>
      current.fetch(
        new Request(`https://session.internal/stream${params.search}`, {
          headers: { Upgrade: 'websocket' },
        })
      ),
    params.operationName
  );
  let response: Response;
  try {
    response = await withTimeout(connect, OPEN_DEADLINE_MS, 'Session stream open timed out');
  } catch {
    logger.withFields({ operation: params.operationName }).warn('Session stream open failed');
    // Close a socket that arrives after the deadline so it does not leak.
    void connect.then(late => late.webSocket?.close()).catch(() => undefined);
    return { kind: 'unavailable' };
  }
  if (response.status === 404) {
    response.webSocket?.close();
    return { kind: 'stopped' };
  }
  const socket = response.webSocket;
  if (!socket) return { kind: 'unavailable' };
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    params.onMessage(payload);
  });
  socket.addEventListener('close', () => params.onEnd());
  socket.addEventListener('error', () => params.onEnd());
  socket.accept();
  return {
    kind: 'open',
    socket: {
      close() {
        try {
          socket.close(1000, 'Session stream closed');
        } catch {
          // The socket is already closed.
        }
      },
    },
  };
}
