import { env, evictAllDurableObjects, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { SessionEventQueries } from '../../src/control-plane/session/event-queries.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';

const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const owner = 'user_123';

function fixture() {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const stub = sessions.getByName(sessionId);
  return {
    sessionId,
    stub,
    input: {
      metadata: parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId, userId: owner, createdOnPlatform: 'cloud-agent-web' },
        auth: {
          kiloSessionId: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
          kilocodeToken: `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ runtimeAuthorization: { id: 'synthetic-authorization' } }))}.sig`,
        },
        agent: { mode: 'code', model: 'kilo/fake-deterministic' },
        workspace: { sandboxId: `ses-${'a'.repeat(48)}`, sandboxProvider: 'cloudflare-containers' },
        lifecycle: { version: 1, timestamp: 1 },
      }),
      sandboxSelection: { provider: 'cloudflare-containers' as const },
    },
  };
}

async function connectingCatalog(sessionId: string): Promise<unknown> {
  const response = await SELF.fetch(
    `http://worker.test/stream-v2?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { Upgrade: 'websocket' } }
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('Missing session stream');
  socket.accept();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing command catalog')), 3_000);
      socket.addEventListener('message', event => {
        const frame = z
          .object({ streamEventType: z.string(), data: z.unknown() })
          .parse(JSON.parse(String(event.data)));
        if (frame.streamEventType !== 'commands.available') return;
        clearTimeout(timer);
        resolve(frame.data);
      });
    });
  } finally {
    socket.close();
  }
}

afterEach(async () => {
  await reset();
});

describe('new sibling command catalog', () => {
  it.each(['catalog write', 'event upsert'] as const)(
    'retries registration after a failed %s without losing the seeded catalog',
    async failure => {
      const sibling = fixture();
      const input = {
        ...sibling.input,
        initialCommands: { commands: [{ name: 'profile-check' }] },
      };
      await runInDurableObject(sibling.stub, async (instance, state) => {
        await instance.getMetadata();
        const { eventQueries } = instance as unknown as { eventQueries: SessionEventQueries };
        const put = state.storage.put.bind(state.storage);
        const fault =
          failure === 'catalog write'
            ? vi.spyOn(state.storage, 'put').mockImplementation(async (key, value) => {
                if (key === 'available_commands') throw new Error('catalog write failed');
                if (typeof key === 'string') await put(key, value);
                else await put(key);
              })
            : vi.spyOn(eventQueries, 'upsert').mockImplementationOnce(() => {
                throw new Error('event upsert failed');
              });
        try {
          await expect(instance.registerSessionFromMetadata(input)).rejects.toThrow(
            `${failure} failed`
          );
          expect(await instance.getMetadata()).toBeNull();
          expect(await state.storage.get('control_plane_session')).toBeUndefined();
          expect(await state.storage.get('session_metadata')).toBeUndefined();
        } finally {
          fault.mockRestore();
        }
      });
      await evictAllDurableObjects();
      expect(await sibling.stub.registerSessionFromMetadata(input)).toEqual({ success: true });
      const catalog = await sibling.stub.getAvailableCommands();
      expect(catalog.commands.map(command => command.name)).toContain('profile-check');
      await runInDurableObject(sibling.stub, instance => {
        const { eventQueries } = instance as unknown as { eventQueries: SessionEventQueries };
        expect(eventQueries.findByEntityId('commands-available')?.payload).toBe(
          JSON.stringify(catalog)
        );
      });
      await evictAllDurableObjects();
      expect(await connectingCatalog(sibling.sessionId)).toEqual(catalog);
    }
  );

  it('hydrates the workspace catalog before the first message without preparing a runtime', async () => {
    const source = fixture();
    expect(await source.stub.registerSessionFromMetadata(source.input)).toEqual({ success: true });
    await source.stub.onEvents({
      events: [
        {
          type: 'commands.available',
          properties: {
            commands: [
              {
                name: 'profile-check',
                description: 'Synthetic command',
                template: 'private template',
              },
            ],
            catalogStatus: { dropped: 1, overLimit: false },
          },
        },
      ],
    });
    const sibling = fixture();
    const initialCommands = await source.stub.getAvailableCommands();
    expect(
      await sibling.stub.registerSessionFromMetadata({ ...sibling.input, initialCommands })
    ).toEqual({ success: true });
    expect(await connectingCatalog(sibling.sessionId)).toMatchObject({
      commands: expect.arrayContaining([
        { name: 'profile-check', description: 'Synthetic command', hints: [] },
      ]),
      catalogStatus: { dropped: 1, overLimit: false },
    });
    expect(JSON.stringify(await sibling.stub.getAvailableCommands())).not.toContain('template');
    const snapshot = await sibling.stub.getSession();
    expect(snapshot).toMatchObject({ type: 'found', messages: [], route: { state: 'unknown' } });
    await evictAllDurableObjects();
    expect(await connectingCatalog(sibling.sessionId)).toEqual(initialCommands);
    const independent = fixture();
    await independent.stub.registerSessionFromMetadata(independent.input);
    expect(await independent.stub.getAvailableCommands()).toEqual({ commands: [] });
  });

  it('keeps a newer native catalog when sibling registration is replayed', async () => {
    const sibling = fixture();
    const input = { ...sibling.input, initialCommands: { commands: [{ name: 'old-command' }] } };
    expect(await sibling.stub.registerSessionFromMetadata(input)).toEqual({ success: true });
    await sibling.stub.onEvents({
      events: [{ type: 'commands.available', properties: { commands: [{ name: 'new-command' }] } }],
    });
    expect(await sibling.stub.registerSessionFromMetadata(input)).toEqual({ success: true });
    const catalog = await sibling.stub.getAvailableCommands();
    expect(catalog.commands.map(command => command.name)).toContain('new-command');
    expect(catalog.commands.map(command => command.name)).not.toContain('old-command');
  });
});
