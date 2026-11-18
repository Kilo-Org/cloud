import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { UserConnectionDO } from '../../src/dos/UserConnectionDO';

const CAPACITY_MESSAGE = "A WebSocket 'attachment' cannot be larger than 16384 bytes.";
const FRAME_LIMIT_BYTES = 16_384;

function oversizedHeartbeat(titleLength: number) {
  return {
    type: 'heartbeat',
    sessions: [
      {
        id: 'ses_native_capacity',
        status: 'busy',
        title: 'T'.repeat(titleLength),
        gitUrl: 'https://github.com/org/project.git',
        gitBranch: 'session-branch',
        parentSessionId: 'ses_parent',
        platform: 'darwin',
      },
    ],
    protocolVersion: '1',
    capabilities: { attachments: true, sessionClone: true },
    instance: { name: 'host', projectName: 'project', version: '1.0.0' },
  };
}

it('keeps the acknowledgement and a saveable attachment when a heartbeat exceeds the frame', async () => {
  const stub = env.USER_CONNECTION_DO.get(env.USER_CONNECTION_DO.newUniqueId());
  const written = await runInDurableObject(stub, async (instance: UserConnectionDO, state) => {
    const [client, server] = Object.values(new WebSocketPair());
    state.acceptWebSocket(server, ['cli']);
    client.accept();
    const now = Date.now();
    server.serializeAttachment({
      role: 'cli',
      connectionId: 'native-capacity',
      sessions: [],
      heartbeatAt: now,
      kiloUserId: 'usr_native_capacity',
    });
    const seeded: unknown = server.deserializeAttachment();
    const messages: unknown[] = [];
    client.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));

    try {
      // The native limit this fix works around: an oversize write throws and
      // leaves the previous attachment in place.
      const oversize = oversizedHeartbeat(64 * 1024);
      const bytes = new TextEncoder().encode(JSON.stringify(oversize)).byteLength;
      expect(bytes).toBeGreaterThan(FRAME_LIMIT_BYTES);
      expect(() => server.serializeAttachment(oversize)).toThrow(CAPACITY_MESSAGE);
      expect(server.deserializeAttachment()).toEqual(seeded);

      const sessions = Array.from({ length: 200 }, (_, index) => ({
        id: `ses_capacity_${index}`,
        status: index === 0 ? 'permission' : 'busy',
        title: 'A session title long enough to fill the attachment frame',
        platform: 'vscode',
      }));
      await instance.webSocketMessage(
        server,
        JSON.stringify({
          type: 'heartbeat',
          protocolVersion: '1',
          capabilities: { attachments: true },
          instance: { name: 'host', projectName: 'project', version: '1.0.0' },
          sessions,
        })
      );

      // Every row still drives the live snapshot...
      expect(instance.getActiveSessions()).toHaveLength(sessions.length);
      expect(instance.hasActiveCliSession('ses_capacity_199')).toBe(true);
      // ...and the writer kept the approval row while shedding the rest.
      const persisted = server.deserializeAttachment() as {
        sessions: Array<{ id: string }>;
        instance?: unknown;
        kiloUserId?: string;
      };
      // The acknowledgement is the CLI's only keepalive: wait for delivery rather
      // than racing the client's message event.
      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(persisted.kiloUserId).toBe('usr_native_capacity');
      expect(persisted.instance).toEqual({
        name: 'host',
        projectName: 'project',
        version: '1.0.0',
      });
      const persistedIds = persisted.sessions.map(session => session.id);
      expect(persistedIds).toContain('ses_capacity_0');
      expect(persistedIds.length).toBeGreaterThan(0);
      expect(persistedIds.length).toBeLessThan(sessions.length);
      return {
        messages: [...messages],
        persistedBytes: new TextEncoder().encode(JSON.stringify(persisted)).byteLength,
      };
    } finally {
      await instance.webSocketMessage(server, JSON.stringify({ type: 'heartbeat', sessions: [] }));
      await state.storage.deleteAlarm();
      client.close();
      server.close();
    }
  });

  expect(written.persistedBytes).toBeLessThanOrEqual(FRAME_LIMIT_BYTES);
  expect(written.messages).toEqual([{ type: 'heartbeat_ack' }]);
});
