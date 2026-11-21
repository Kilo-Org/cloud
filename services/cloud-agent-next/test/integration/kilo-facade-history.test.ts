import { SELF, env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import {
  decodeKiloSdkMessagesCursor,
  kiloSdkStoredMessageSchema,
  type Kilo2Message,
} from '@kilocode/session-ingest-contracts';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { events } from '../../src/control-plane/session/sqlite-schema.js';
import { sessionDoName } from '../../src/session-identity.js';
import { publicCloudAgentDirectory } from '../../src/kilo-facade/public-sdk-projection.js';
import { seedRegistration } from './helpers/seed-registration.js';
import {
  writeTestSessionIngestState,
  createTestSessionIngestDouble,
} from './helpers/session-ingest-double.js';

const userId = 'oauth/history-owner';
const responseSchema = z.array(kiloSdkStoredMessageSchema);
const sessions = env.SANDBOX_SESSION as DurableObjectNamespace<SandboxSessionV2>;

async function fixture(version: 'v1' | 'v2' = 'v2') {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const stub = sessions.getByName(sessionDoName(userId, sessionId));
  await seedRegistration(stub, {
    sandboxId: `ses-${crypto.randomUUID().replaceAll('-', '')}`,
    spec: { sessionId, kiloSessionId, directory: '/workspace/private', attemptId: 'history-only' },
    credentials: { userId, kiloSessionId, kiloToken: 'synthetic-token', scopeId: sessionId },
  });
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => {
      throw new Error('History must not contact the sandbox');
    };
  });
  const facade = env.USER_KILO_FACADE.getByName(userId);
  await runInDurableObject(facade, async (_instance, state) => {
    await writeTestSessionIngestState(state.storage, {
      roots: [{ kiloSessionId, cloudAgentSessionId: sessionId, organizationId: 'synthetic-org' }],
    });
  });
  const source = {
    version: 'v2' as const,
    session: {
      id: kiloSessionId,
      location: { directory: '/workspace/private' },
      model: { providerID: 'kilo', id: 'synthetic-model' },
      time: { created: 1, updated: 4 },
    },
  };
  if (version === 'v2')
    await stub.onEvents({
      events: [{ type: 'conversation.source', properties: { sessionID: kiloSessionId, source } }],
    });
  const request = (query = '', owner = userId, coreVersion?: string) => {
    const url = new URL(
      `http://worker.test/kilo-test/kilo/session/${kiloSessionId}/message${query}`
    );
    url.searchParams.set('userId', owner);
    return SELF.fetch(url, { headers: coreVersion ? { 'x-kilocode-version': coreVersion } : {} });
  };
  const publish = async (message: Kilo2Message, parentID?: string) =>
    stub.onEvents({
      events: [
        {
          type: 'conversation.message.updated',
          properties: { sessionID: kiloSessionId, source, message, parentID },
        },
      ],
    });
  return { stub, facade, sessionId, kiloSessionId, request, publish };
}

afterEach(async () => {
  await reset();
});

describe('public persisted Cloud history', () => {
  it('keeps tied timestamps in deterministic order across pages', async () => {
    const f = await fixture();
    for (const suffix of ['d', 'b', 'c', 'a'])
      await f.publish({ id: `msg_${suffix}`, type: 'user', time: { created: 1 }, text: suffix });
    const first = await f.request('?limit=2');
    expect(responseSchema.parse(await first.json()).map(item => item.info.id)).toEqual([
      'msg_c',
      'msg_d',
    ]);
    const second = await f.request(`?limit=2&before=${first.headers.get('x-next-cursor')}`);
    expect(responseSchema.parse(await second.json()).map(item => item.info.id)).toEqual([
      'msg_a',
      'msg_b',
    ]);
    expect(second.headers.get('x-next-cursor')).toBeNull();
  });

  it('does not disguise a failed v2 page as pending ingest or an empty transcript', async () => {
    const f = await fixture();
    await f.publish({ id: 'msg_corrupt', type: 'user', time: { created: 1 }, text: 'stored' });
    await runInDurableObject(f.stub, (_instance, state) => {
      drizzle(state.storage)
        .update(events)
        .set({ payload: '{' })
        .where(eq(events.entity_id, 'message/msg_corrupt'))
        .run();
    });
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toMatchObject({ error: 'KILO_SESSION_READ_RETRYABLE' });
  });

  it('reads native v2 DO history without ingest, across pages and old/new clients, while cold', async () => {
    const f = await fixture();
    for (let turn = 1; turn <= 3; turn++) {
      await f.publish({
        id: `msg_user_${turn}`,
        type: 'user',
        time: { created: turn },
        text: `question ${turn}`,
      });
      await f.publish(
        {
          id: `msg_assistant_${turn}`,
          type: 'assistant',
          time: { created: turn + 0.5, completed: turn + 0.6 },
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: `answer ${turn}` },
            {
              type: 'tool',
              id: `call_${turn}`,
              name: 'shell',
              state: {
                status: 'completed',
                input: { command: 'pwd' },
                content: [{ type: 'text', text: '/workspace/private' }],
              },
            },
          ],
        },
        `msg_user_${turn}`
      );
    }
    await runInDurableObject(f.facade, async (_instance, state) => {
      const ingest = createTestSessionIngestDouble(state.storage);
      expect(
        await ingest.getCloudAgentRootSessionMessages({
          kiloUserId: userId,
          kiloSessionId: f.kiloSessionId,
        })
      ).toMatchObject({ history: null });
    });
    await evictDurableObject(f.stub);
    const first = await f.request('?limit=2', userId, '1.0.0');
    expect(first.status).toBe(200);
    const newest = responseSchema.parse(await first.json());
    expect(newest.map(item => item.info.id)).toEqual(['msg_user_3', 'msg_assistant_3']);
    expect(newest[1]?.info).toMatchObject({
      parentID: 'msg_user_3',
      path: {
        cwd: publicCloudAgentDirectory(f.kiloSessionId),
        root: publicCloudAgentDirectory(f.kiloSessionId),
      },
    });
    expect(newest[1]?.parts.map(part => part.id)).toEqual([
      'msg_assistant_3_000000',
      'msg_assistant_3_000001',
      'msg_assistant_3_000002',
    ]);
    expect(newest[1]?.parts[2]).toMatchObject({ type: 'tool', tool: 'bash', callID: 'call_3' });
    expect(first.headers.get('x-kilo-omitted-item-count')).toBe('0');
    const cursor = first.headers.get('x-next-cursor');
    expect(cursor).toBeTruthy();
    expect(first.headers.get('link')).toContain(`before=${cursor}`);
    const second = await f.request(`?limit=2&before=${cursor}`);
    expect(second.status).toBe(200);
    const older = responseSchema.parse(await second.json());
    expect(older.map(item => item.info.id)).toEqual(['msg_user_2', 'msg_assistant_2']);
    const newClient = await f.request('?limit=2', userId, '2.0.0');
    expect(await newClient.json()).toEqual(newest);
    const all = await f.request();
    expect(responseSchema.parse(await all.json()).map(item => item.info.id)).toEqual([
      'msg_user_1',
      'msg_assistant_1',
      ...older.map(item => item.info.id),
      ...newest.map(item => item.info.id),
    ]);
    const zero = await f.request('?limit=0');
    expect(responseSchema.parse(await zero.json())).toHaveLength(6);
  });

  it('preserves v1 ingest history and cursor pagination', async () => {
    const f = await fixture('v1');
    const messages = [1, 2, 3].map(index => ({
      info: {
        id: `msg_v1_${index}`,
        sessionID: f.kiloSessionId,
        role: 'user' as const,
        time: { created: index },
        agent: 'code',
        model: { providerID: 'kilo', modelID: 'test' },
      },
      parts: [
        {
          id: `prt_v1_${index}`,
          sessionID: f.kiloSessionId,
          messageID: `msg_v1_${index}`,
          type: 'text' as const,
          text: `v1 ${index}`,
        },
      ],
    }));
    await runInDurableObject(f.facade, async (_instance, state) => {
      await writeTestSessionIngestState(state.storage, {
        messages: { [f.kiloSessionId]: messages },
      });
    });
    const first = await f.request('?limit=1', userId, '2.0.0');
    expect(first.status).toBe(200);
    expect(responseSchema.parse(await first.json())).toEqual([messages[2]]);
    const cursor = first.headers.get('x-next-cursor');
    expect(decodeKiloSdkMessagesCursor(cursor ?? '')).toEqual({ id: 'msg_v1_3', time: 3 });
    const second = await f.request(`?limit=1&before=${cursor}`);
    expect(second.status).toBe(200);
    expect(responseSchema.parse(await second.json())).toEqual([messages[1]]);
  });

  it('returns empty only for a confirmed empty v2 source and keeps missing v1 history pending', async () => {
    const f = await fixture();
    const empty = await f.request();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    const v1 = await fixture('v1');
    const pending = await v1.request();
    expect(pending.status).toBe(503);
    expect(pending.headers.get('retry-after')).toBe('1');
    expect(await pending.json()).toMatchObject({ error: 'KILO_SESSION_SNAPSHOT_PENDING' });
  });

  it('denies foreign owners, removed access, mismatched roots, directories, and cross-session cursors', async () => {
    const f = await fixture();
    await f.publish({ id: 'msg_owned', type: 'user', time: { created: 1 }, text: 'private' });
    expect((await f.request('', 'foreign-owner')).status).toBe(404);
    expect((await f.request('?directory=%2Fworkspace%2Fprivate')).status).toBe(400);
    const other = await fixture();
    await other.publish({ id: 'msg_other_1', type: 'user', time: { created: 1 }, text: 'other' });
    await other.publish({ id: 'msg_other_2', type: 'user', time: { created: 2 }, text: 'other' });
    const cursor = (await other.request('?limit=1')).headers.get('x-next-cursor');
    await runInDurableObject(f.facade, async (_instance, state) => {
      await writeTestSessionIngestState(state.storage, {
        roots: [{ kiloSessionId: f.kiloSessionId, cloudAgentSessionId: f.sessionId }],
      });
    });
    expect((await f.request(`?limit=1&before=${cursor}`)).status).toBe(400);
    await runInDurableObject(f.facade, async (_instance, state) => {
      await writeTestSessionIngestState(state.storage, {
        roots: [{ kiloSessionId: f.kiloSessionId, cloudAgentSessionId: other.sessionId }],
      });
    });
    expect((await f.request()).status).toBe(404);
    await runInDurableObject(f.facade, async (_instance, state) => {
      await writeTestSessionIngestState(state.storage, { roots: [] });
    });
    expect((await f.request()).status).toBe(404);
  });
});
