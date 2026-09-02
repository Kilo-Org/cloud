import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { UserConnectionDO } from '../../src/dos/UserConnectionDO';

it('preserves the current heartbeat through native attachment capacity fallback', async () => {
  const stub = env.USER_CONNECTION_DO.get(env.USER_CONNECTION_DO.newUniqueId());
  const evidence = await runInDurableObject(stub, async (instance: UserConnectionDO, state) => {
    const [client, server] = Object.values(new WebSocketPair());
    state.acceptWebSocket(server, ['cli']);
    client.accept();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const heartbeat = (titleLength: number) => ({
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
          prLink: {
            platform: 'github',
            prUrl: 'https://github.com/org/project/pull/1',
            prNumber: 1,
          },
        },
      ],
      protocolVersion: '1',
      capabilities: { attachments: true, sessionClone: true },
      instance: { name: 'host', projectName: 'project', version: '1.0.0' },
    });
    server.serializeAttachment({
      role: 'cli',
      connectionId: 'native-capacity',
      sessions: [],
      heartbeatAt: now,
      kiloUserId: 'usr_native_capacity',
    });
    const nativeSerialize = server.serializeAttachment.bind(server);
    const failures: unknown[] = [];
    // Observe the real serializer without replacing its capacity behavior.
    const write = vi.spyOn(server, 'serializeAttachment').mockImplementation(value => {
      const before: unknown = server.deserializeAttachment();
      try {
        nativeSerialize(value);
      } catch (error) {
        failures.push(error);
        expect(server.deserializeAttachment()).toEqual(before);
        throw error;
      }
    });
    try {
      // Calibrate through the production parser and heartbeat write, not a
      // hand-built fixture or JSON length.
      let fitting = 0;
      let rejected = 64 * 1024;
      await instance.webSocketMessage(server, JSON.stringify(heartbeat(fitting)));
      await expect(
        instance.webSocketMessage(server, JSON.stringify(heartbeat(rejected)))
      ).rejects.toThrow("A WebSocket 'attachment' cannot be larger than 16384 bytes.");
      while (fitting + 1 < rejected) {
        const length = Math.floor((fitting + rejected) / 2);
        try {
          await instance.webSocketMessage(server, JSON.stringify(heartbeat(length)));
          fitting = length;
        } catch (error) {
          expect(error).toMatchObject({
            name: 'Error',
            message: expect.stringContaining(
              "A WebSocket 'attachment' cannot be larger than 16384 bytes."
            ),
          });
          rejected = length;
        }
      }
      const current = heartbeat(fitting);
      await instance.webSocketMessage(server, JSON.stringify(current));
      const legacy = {
        role: 'cli',
        connectionId: 'native-capacity',
        sessions: current.sessions,
        heartbeatAt: now,
        protocolVersion: '1',
        capabilities: current.capabilities,
        kiloUserId: 'usr_native_capacity',
        instance: current.instance,
      };
      expect(server.deserializeAttachment()).toEqual(legacy);

      // Install a previous heartbeat to detect retries that reuse stale fields.
      clock.mockReturnValue(now - 5_000);
      await instance.webSocketMessage(
        server,
        JSON.stringify({
          ...current,
          sessions: [
            {
              id: 'ses_previous',
              status: 'idle',
              title: 'Previous',
              parentSessionId: 'ses_parent',
            },
          ],
          protocolVersion: '0',
          capabilities: { attachments: false, sessionClone: false },
          instance: { name: 'previous-host', projectName: 'previous-project', version: '0.0.0' },
        })
      );
      clock.mockReturnValue(now);
      const enriched = {
        ...current,
        instance: {
          ...current.instance,
          kind: 'remote',
          startedAt: '2026-08-28T12:34:56.789Z',
          gitBranch: 'b'.repeat(24),
        },
      };
      failures.length = 0;
      write.mockClear();
      await instance.webSocketMessage(server, JSON.stringify(enriched));
      expect(failures).toHaveLength(1);
      const [failure] = failures;
      if (!(failure instanceof Error)) throw new Error('Expected a native capacity exception');
      const capacityEvidence = {
        name: failure.name,
        constructor: failure.constructor.name,
        message: failure.message,
      };
      expect(write).toHaveBeenCalledTimes(2);
      expect(server.deserializeAttachment()).toEqual(legacy);
      expect(instance.hasActiveCliSession('ses_native_capacity')).toBe(true);
      expect(instance.hasActiveCliSession('ses_previous')).toBe(false);
      expect(instance.getConnectedInstances()).toEqual({
        instances: [
          {
            connectionId: legacy.connectionId,
            ...current.instance,
            capabilities: current.capabilities,
          },
        ],
      });

      // A later fitting heartbeat must advertise metadata again, not keep the fallback.
      await instance.webSocketMessage(server, JSON.stringify({ ...enriched, sessions: [] }));
      expect(server.deserializeAttachment()).toEqual({
        ...legacy,
        instance: enriched.instance,
        sessions: [],
      });
      expect(instance.getConnectedInstances()).toEqual({
        instances: [
          {
            connectionId: legacy.connectionId,
            ...enriched.instance,
            capabilities: current.capabilities,
          },
        ],
      });
      return capacityEvidence;
    } finally {
      write.mockRestore();
      clock.mockRestore();
      // Empty the owned connection before close; this test needs no Postgres disconnect work.
      await instance.webSocketMessage(server, JSON.stringify({ type: 'heartbeat', sessions: [] }));
      await state.storage.deleteAlarm();
      client.close();
      server.close();
    }
  });
  // Pin the measured native exception separately from the production classifier.
  expect(evidence).toEqual({
    name: 'Error',
    constructor: 'Error',
    message:
      "A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 16472 bytes.",
  });
});
