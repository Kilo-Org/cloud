import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { UserConnectionDO } from '../../src/dos/UserConnectionDO';

type JsonRecord = Record<string, unknown>;

type UserConnectionStub = ReturnType<DurableObjectNamespace<UserConnectionDO>['get']>;

type MessagePredicate = (message: JsonRecord) => boolean;

/**
 * Message collector for a client WebSocket. Buffers every inbound frame and
 * lets the test await the next frame matching a predicate.
 */
function collectMessages(ws: WebSocket) {
  const messages: JsonRecord[] = [];
  const waiters: Array<{
    predicate: MessagePredicate;
    resolve: (message: JsonRecord) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  ws.addEventListener('message', (event: MessageEvent) => {
    const parsed = JSON.parse(String(event.data)) as JsonRecord;
    messages.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.predicate(parsed)) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
        return;
      }
    }
  });

  return {
    messages,
    count(predicate: MessagePredicate): number {
      return messages.filter(predicate).length;
    },
    next(predicate: MessagePredicate, timeoutMs = 5_000): Promise<JsonRecord> {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<JsonRecord>((resolve, reject) => {
        let waiter: {
          predicate: MessagePredicate;
          resolve: (message: JsonRecord) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for a message matching the predicate`));
        }, timeoutMs);
        waiter = {
          predicate,
          resolve,
          reject,
          timer,
        };
        waiters.push(waiter);
      });
    },
  };
}

/**
 * Open a WebSocket to the UserConnectionDO at the given path (either `/cli` or
 * `/web`) and return the accepted client socket.
 */
async function connectWs(stub: UserConnectionStub, path: string): Promise<WebSocket> {
  const response = await stub.fetch(`http://user-connection.test${path}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  if (!response.webSocket) {
    throw new Error(`Expected a WebSocket in the upgrade response for ${path}`);
  }
  response.webSocket.accept();
  return response.webSocket;
}

describe('UserConnectionDO integration', () => {
  it('dedupes connection-scoped create_session by mutationId and replays the durable terminal envelope after hibernation', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const doName = `ucdo-create-session-${suffix}`;
    const stub = env.USER_CONNECTION_DO.get(env.USER_CONNECTION_DO.idFromName(doName));

    // Stable caller key; the SDK maps it to `:ext` (extended attempt) and
    // `:bare` (old-CLI retry) wire identities.
    const extId = `spawn-${suffix}:ext`;
    const sessionId = `ses_${suffix.slice(0, 26)}`;

    const cliWs = await connectWs(stub, `/cli?connectionId=cli-owner-1`);
    const cli = collectMessages(cliWs);
    cliWs.send(JSON.stringify({ type: 'heartbeat', protocolVersion: '1', sessions: [] }));

    const webWs1 = await connectWs(stub, `/web?connectionId=web-1`);
    const web1 = collectMessages(webWs1);

    // Track every socket the test opens so the cleanup below closes each one
    // deterministically, including the post-hibernation socket.
    const sockets: WebSocket[] = [cliWs, webWs1];

    try {
      // Connection-scoped create_session with the extended wire identity.
      webWs1.send(
        JSON.stringify({
          type: 'command',
          id: 'req-1',
          command: 'create_session',
          connectionId: 'cli-owner-1',
          mutationId: extId,
          data: { protocolVersion: 1, agent: 'code' },
        })
      );

      // The CLI receives the command with the mutation identity echoed on the
      // wire (proves the SDK/relay forwards it for durable dedupe).
      const cliCommand = await cli.next(
        message => message.type === 'command' && message.command === 'create_session'
      );
      expect(cliCommand).toEqual({
        type: 'command',
        id: extId,
        command: 'create_session',
        mutationId: extId,
        data: { protocolVersion: 1, agent: 'code' },
      });

      // Duplicate send while the command is in flight: dedupe by mutationId.
      // The CLI must not receive a second command.
      webWs1.send(
        JSON.stringify({
          type: 'command',
          id: 'req-dup',
          command: 'create_session',
          connectionId: 'cli-owner-1',
          mutationId: extId,
          data: { protocolVersion: 1 },
        })
      );
      const dupResponse = await web1.next(
        message => message.type === 'response' && message.id === 'req-dup'
      );
      expect(dupResponse.error).toMatchObject({ code: 'COMMAND_ALREADY_PENDING' });
      expect(cli.count(message => message.type === 'command')).toBe(1);

      // The CLI answers with the live v1 envelope.
      cliWs.send(
        JSON.stringify({
          type: 'response',
          id: extId,
          result: { protocolVersion: 1, sessionID: sessionId },
        })
      );
      const liveEnvelope = await web1.next(
        message => message.type === 'response' && message.id === 'req-1'
      );
      expect(liveEnvelope).toEqual({
        type: 'response',
        id: 'req-1',
        result: { protocolVersion: 1, sessionID: sessionId },
      });

      // The durable entry is terminal.
      const durable = await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(`pendingCommand/${extId}`)
      );
      expect(durable).toBeDefined();
      expect((durable as JsonRecord).state).toBe('done');
      expect((durable as JsonRecord).result).toEqual({
        protocolVersion: 1,
        sessionID: sessionId,
      });

      // Simulated hibernation: the web side drops its socket (the durable
      // entry survives — web disconnect keeps it) and a fresh web socket
      // re-sends the same mutation identity. The DO must replay the durable
      // terminal envelope without re-forwarding to the CLI.
      webWs1.close(1000, 'hibernation drop');
      const webWs2 = await connectWs(stub, `/web?connectionId=web-2`);
      sockets.push(webWs2);
      const web2 = collectMessages(webWs2);

      webWs2.send(
        JSON.stringify({
          type: 'command',
          id: 'req-2',
          command: 'create_session',
          connectionId: 'cli-owner-1',
          mutationId: extId,
          data: { protocolVersion: 1 },
        })
      );

      // Classifier-identical: the replayed durable envelope carries exactly
      // the live envelope's result, under the new request id.
      const replayedEnvelope = await web2.next(
        message => message.type === 'response' && message.id === 'req-2'
      );
      expect(replayedEnvelope).toEqual({
        type: 'response',
        id: 'req-2',
        result: { protocolVersion: 1, sessionID: sessionId },
      });

      // The durable replay never re-forwards to the CLI.
      expect(cli.count(message => message.type === 'command')).toBe(1);
    } finally {
      for (const ws of sockets) {
        ws.close(1000, 'test complete');
      }
    }
  });
});
