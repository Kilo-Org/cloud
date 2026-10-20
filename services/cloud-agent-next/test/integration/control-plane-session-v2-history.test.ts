import { env, reset, runInDurableObject } from 'cloudflare:test';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { createSessionEventQueries } from '../../src/control-plane/session/event-queries.js';
import { MAX_SESSION_PAGE_BYTES } from '../../src/control-plane/session/history.js';
import {
  hydrateSessionHistory,
  markHistoryHydrated,
  readHistoryHydration,
} from '../../src/control-plane/session/history-hydration.js';
import {
  persistSessionEvent,
  readNativeEventPayload,
} from '../../src/control-plane/session/native-events.js';
import {
  eventMutationCursor,
  events,
  historyImport,
} from '../../src/control-plane/session/sqlite-schema.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { sessionDoName } from '../../src/session-plane.js';
import type { SessionIngestBinding } from '../../src/session-ingest-binding.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';

const USER_ID = 'history-user';
const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const nativeId = () => `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;

async function fixture() {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const kiloSessionId = nativeId();
  const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
  const stub = sessions.getByName(sessionDoName(USER_ID, sessionId));
  const peer = new FakeSandboxPeer();
  await stub.registerSessionFromMetadata({
    metadata: parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId, userId: USER_ID, createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId, kilocodeToken: 'test-kilo-token' },
      agent: { mode: 'code', model: 'test/model' },
      workspace: { sandboxId, branchName: 'kilo/history' },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await stub.registerSession({
    sandboxId,
    spec: {
      sessionId,
      kiloSessionId,
      directory: `/workspace/${sessionId}`,
      attemptId: `${sessionId}-requested`,
    },
    credentials: {
      userId: USER_ID,
      kiloSessionId,
      kiloToken: 'test-kilo-token',
      scopeId: sessionId,
    },
  });
  await runInDurableObject(stub, (_instance, state) => {
    markHistoryHydrated(state.storage);
  });
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
  return { stub, sessionId, kiloSessionId, peer };
}

function message(sessionID: string, id: string, created: number) {
  return {
    id,
    sessionID,
    role: 'user' as const,
    time: { created },
    agent: 'code',
    model: { providerID: 'kilo', modelID: 'test/model' },
  };
}

function part(sessionID: string, messageID: string, id: string, text = 'history text') {
  return { id, sessionID, messageID, type: 'text', text };
}

async function publish(
  stub: DurableObjectStub<SandboxSessionV2>,
  type: string,
  properties: Record<string, unknown>
) {
  await stub.onEvents({ events: [{ type, properties }] });
}

function snapshot(id: string) {
  return {
    id,
    slug: 'history',
    projectID: 'project',
    directory: '/workspace/app',
    title: 'Hydrated history',
    version: '1',
    time: { created: 1, updated: 2 },
  };
}

afterEach(async () => {
  await reset();
});

describe('workspace DO history and mutation cursors', () => {
  it('retains stable row identities while mutations advance independently', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_first', 1) });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_first', 'prt_first', 'before'),
    });
    const before = await stub.getSessionMessagesPage();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_later', 2) });
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const row = queries.findByEntityId('part/msg_first/prt_first');
      await instance.onEvents({
        events: [
          {
            type: 'message.part.updated',
            properties: { part: part(kiloSessionId, 'msg_first', 'prt_first', 'after') },
          },
        ],
      });
      const next = queries.findByEntityId('part/msg_first/prt_first');
      expect(next?.id).toBe(row?.id);
      expect(next?.mutation_cursor).toBeGreaterThan(before?.updateCursor ?? 0);
      const updates = queries.findByFilters({ afterCursor: before?.updateCursor ?? 0 });
      expect(updates.map(event => event.id)).toContain(row?.id);
      expect(updates.map(event => event.mutation_cursor)).toEqual(
        [...updates.map(event => event.mutation_cursor)].sort((a, b) => (a ?? 0) - (b ?? 0))
      );
      expect(queries.getTotalCostMicrodollars(sessionId, kiloSessionId)).toBe(0);
    });
  });

  it('bounds native replay reads by event ID independently of mutation cursors', async () => {
    const { stub, sessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const input = {
        executionId: '',
        sessionId,
        streamEventType: 'output',
        payload: '{}',
        timestamp: 1,
      };
      const first = queries.upsert({ ...input, entityId: 'first' });
      const second = queries.insert(input);
      queries.insert(input);
      queries.upsert({ ...input, entityId: 'first', timestamp: 2 });
      const filters = { fromId: first, toId: second };
      expect(queries.findByFilters(filters).map(event => event.id)).toEqual([second]);
      expect([...queries.iterateByFilters(filters)].map(event => event.id)).toEqual([second]);
      expect(queries.findByFilters({ toId: first }).map(event => event.id)).toEqual([first]);
    });
  });

  it('rolls cursor allocation and row insertion back as one transaction', async () => {
    const { stub, sessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage);
      const queries = createSessionEventQueries(db, state.storage);
      const cursor = queries.getUpdateCursor();
      expect(() =>
        state.storage.transactionSync(() => {
          queries.insert({
            executionId: '',
            sessionId,
            streamEventType: 'output',
            payload: '{}',
            timestamp: 1,
          });
          throw new Error('rollback');
        })
      ).toThrow('rollback');
      expect(queries.getUpdateCursor()).toBe(cursor);
      expect(queries.getLatestEventId()).toBeNull();
    });
  });

  it('does not allocate a mutation cursor for an idempotent unique insert', async () => {
    const { stub, sessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const input = {
        executionId: '',
        sessionId,
        streamEventType: 'output',
        payload: '{}',
        timestamp: 1,
        entityId: 'unique',
      };
      expect(queries.insertUnique(input)).toBeGreaterThan(0);
      const cursor = queries.getUpdateCursor();
      expect(queries.insertUnique(input)).toBeNull();
      expect(queries.getUpdateCursor()).toBe(cursor);
    });
  });

  it('pages chronologically even when older native rows arrive after live rows', async () => {
    const { stub, kiloSessionId, peer } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_newest', 300) });
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_oldest', 100) });
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_middle', 200) });
    const latest = await stub.getSessionMessagesPage({ limit: 2 });
    expect(latest?.messages.map(item => item.info.id)).toEqual(['msg_middle', 'msg_newest']);
    expect(latest?.nextCursor).toBeTypeOf('string');
    const older = await stub.getSessionMessagesPage({
      limit: 2,
      cursor: latest?.nextCursor ?? undefined,
    });
    expect(older?.messages.map(item => item.info.id)).toEqual(['msg_oldest']);
    expect(older?.nextCursor).toBeNull();
    expect(peer.prepareCalls).toHaveLength(0);
    expect(peer.deliverCalls).toHaveLength(0);
  });

  it('keeps timestamp-less legacy rows in stable native identity order', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', {
      info: { id: 'msg_b', role: 'user', sessionID: kiloSessionId },
    });
    await publish(stub, 'message.updated', {
      info: { id: 'msg_a', role: 'user', sessionID: kiloSessionId },
    });
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_timestamped', 1) });
    expect((await stub.getSessionMessagesPage())?.messages.map(item => item.info.id)).toEqual([
      'msg_a',
      'msg_b',
      'msg_timestamped',
    ]);
  });

  it('preserves native creation time when later message updates omit it', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_first', 5) });
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_second', 10) });
    await publish(stub, 'message.updated', {
      info: { id: 'msg_first', role: 'user', sessionID: kiloSessionId, time: { completed: 15 } },
    });
    const page = await stub.getSessionMessagesPage();
    expect(page?.messages.map(item => item.info.id)).toEqual(['msg_first', 'msg_second']);
    expect(page?.messages[0].info.time).toMatchObject({ created: 5, completed: 15 });
  });

  it('merges textless updates without treating explicit empty text as omitted', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_text', 1) });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_text', 'prt_text', 'streamed'),
    });
    await publish(stub, 'message.part.delta', {
      sessionID: kiloSessionId,
      messageID: 'msg_text',
      partID: 'prt_text',
      field: 'text',
      delta: ' text',
    });
    await publish(stub, 'message.part.updated', {
      part: {
        id: 'prt_text',
        sessionID: kiloSessionId,
        messageID: 'msg_text',
        type: 'text',
        time: { end: 10 },
      },
    });
    expect((await stub.getSessionMessagesPage())?.messages[0].parts[0]).toMatchObject({
      text: 'streamed text',
      time: { end: 10 },
    });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_text', 'prt_text', ''),
    });
    expect((await stub.getSessionMessagesPage())?.messages[0].parts[0].text).toBe('');
  });

  it('orders parts by native identity rather than late hydration arrival', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_parts', 1) });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_parts', 'prt_b'),
    });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_parts', 'prt_a'),
    });
    expect((await stub.getSessionMessagesPage())?.messages[0].parts.map(item => item.id)).toEqual([
      'prt_a',
      'prt_b',
    ]);
  });

  it('persists deletions as cursor-bearing tombstones', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_remove', 1) });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_remove', 'prt_remove'),
    });
    const before = await stub.getSessionMessagesPage();
    await publish(stub, 'message.part.removed', {
      sessionID: kiloSessionId,
      messageID: 'msg_remove',
      partID: 'prt_remove',
    });
    expect((await stub.getSessionMessagesPage())?.messages[0].parts).toEqual([]);
    await publish(stub, 'message.removed', { sessionID: kiloSessionId, messageID: 'msg_remove' });
    expect((await stub.getSessionMessagesPage())?.messages).toEqual([]);
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      expect(
        queries
          .findByFilters({ afterCursor: before?.updateCursor ?? 0 })
          .map(row => readNativeEventPayload(row.payload)?.event)
      ).toEqual(['message.part.removed', 'message.removed']);
    });
  });

  it('authorizes descendants against the registered root and isolates child pages', async () => {
    const { stub, kiloSessionId } = await fixture();
    const child = nativeId();
    const grandchild = nativeId();
    await publish(stub, 'session.created', { info: { id: child, parentID: kiloSessionId } });
    await publish(stub, 'session.created', { info: { id: grandchild, parentID: child } });
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_root', 1) });
    await publish(stub, 'message.updated', { info: message(child, 'msg_child', 2) });
    await publish(stub, 'message.updated', { info: message(grandchild, 'msg_grandchild', 3) });
    expect(
      (await stub.getSessionMessagesPage({ kiloSessionId: child }))?.messages.map(
        item => item.info.id
      )
    ).toEqual(['msg_child']);
    expect((await stub.getSessionMessagesPage({ kiloSessionId: grandchild }))?.info).toMatchObject({
      id: grandchild,
      parentID: child,
    });
    expect((await stub.getSessionMessagesPage())?.messages.map(item => item.info.id)).toEqual([
      'msg_root',
    ]);
  });

  it('rejects foreign selectors, native roots and cross-session cursors', async () => {
    const { stub, kiloSessionId } = await fixture();
    const child = nativeId();
    const foreign = nativeId();
    await publish(stub, 'session.created', { info: { id: child, parentID: kiloSessionId } });
    await publish(stub, 'session.updated', { info: { id: foreign } });
    for (let index = 0; index < 2; index += 1)
      await publish(stub, 'message.updated', { info: message(child, `msg_child_${index}`, index) });
    const page = await stub.getSessionMessagesPage({ kiloSessionId: child, limit: 1 });
    expect(await stub.getSessionMessagesPage({ kiloSessionId: foreign })).toBeNull();
    expect(await stub.getSessionMessagesPage({ expectedRootKiloSessionId: foreign })).toBeNull();
    await runInDurableObject(stub, async instance => {
      await expect(
        instance.getSessionMessagesPage({ cursor: page?.nextCursor ?? undefined })
      ).rejects.toThrow('another session');
      await expect(instance.getSessionMessagesPage({ cursor: 'not-a-cursor' })).rejects.toThrow(
        'Invalid session history cursor'
      );
    });
  });

  it('returns a consistent watermark and all-native cost rather than page cost', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'session.updated', { info: { id: kiloSessionId, title: 'Native title' } });
    for (let index = 0; index < 3; index += 1)
      await publish(stub, 'message.updated', {
        info: {
          id: `msg_assistant_${index}`,
          sessionID: kiloSessionId,
          role: 'assistant',
          time: { created: index },
          cost: 0.25,
        },
      });
    const page = await stub.getSessionMessagesPage({ limit: 1 });
    expect(page?.messages).toHaveLength(1);
    expect(page?.totalCostMicrodollars).toBe(750_000);
    expect(await stub.getSession()).toMatchObject({
      title: 'Native title',
      totalCostMicrodollars: 750_000,
      updateCursor: page?.updateCursor,
    });
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      expect(
        queries
          .findByFilters({ throughCursor: page?.updateCursor })
          .every(row => (row.mutation_cursor ?? 0) <= (page?.updateCursor ?? 0))
      ).toBe(true);
    });
  });

  it('bounds actual UTF-8 pages and defers whole messages without dropping them', async () => {
    const { stub, kiloSessionId } = await fixture();
    const text = '\u00e9'.repeat(350_000);
    for (let index = 0; index < 7; index += 1) {
      await publish(stub, 'message.updated', {
        info: message(kiloSessionId, `msg_bytes_${index}`, index + 1),
      });
      await publish(stub, 'message.part.updated', {
        part: part(kiloSessionId, `msg_bytes_${index}`, `prt_bytes_${index}`, text),
      });
    }
    const first = await stub.getSessionMessagesPage();
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
      MAX_SESSION_PAGE_BYTES
    );
    expect(first?.omittedItemCount).toBe(0);
    const second = await stub.getSessionMessagesPage({ cursor: first?.nextCursor ?? undefined });
    expect(
      [...(second?.messages ?? []), ...(first?.messages ?? [])].map(item => item.info.id)
    ).toEqual(Array.from({ length: 7 }, (_, index) => `msg_bytes_${index}`));
    expect(second?.nextCursor).toBeNull();
  });

  it('reports individually oversized message content while advancing pagination', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_huge', 2) });
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_old', 1) });
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      for (let index = 0; index < 4; index += 1)
        queries.upsert({
          executionId: '',
          sessionId,
          streamEventType: 'kilocode',
          entityId: `part/msg_huge/prt_${index}`,
          timestamp: 1,
          payload: JSON.stringify({
            event: 'message.part.updated',
            type: 'message.part.updated',
            properties: {
              part: part(kiloSessionId, 'msg_huge', `prt_${index}`, 'x'.repeat(1_400_000)),
            },
          }),
        });
    });
    const first = await stub.getSessionMessagesPage({ limit: 1 });
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(
      MAX_SESSION_PAGE_BYTES
    );
    expect(first?.omittedItemCount).toBeGreaterThan(0);
    expect(
      (await stub.getSessionMessagesPage({ cursor: first?.nextCursor ?? undefined }))?.messages[0]
        .info.id
    ).toBe('msg_old');
  });

  it('reads staged history batches through the scope and chronological index without sorting', async () => {
    const { stub, kiloSessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage);
      for (const scope of ['', kiloSessionId])
        for (let index = 79; index >= 0; index -= 1)
          db.insert(historyImport)
            .values({
              entity_id: `${scope}/${index.toString().padStart(3, '0')}`,
              kilo_session_id: scope,
              payload: '{}',
              timestamp: Math.floor(index / 2),
            })
            .run();
      for (const scope of ['', kiloSessionId]) {
        const batch = db
          .select()
          .from(historyImport)
          .where(eq(historyImport.kilo_session_id, scope))
          .orderBy(asc(historyImport.timestamp), asc(historyImport.entity_id))
          .limit(20);
        const plan = db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${batch.getSQL()}`);
        expect(plan.map(row => row.detail)).toEqual([
          'SEARCH history_import USING INDEX idx_history_import_scope_timestamp_entity (kilo_session_id=?)',
        ]);
        for (let offset = 0; offset < 80; offset += 20) {
          const rows = batch.all();
          expect(rows.map(row => row.entity_id)).toEqual(
            Array.from(
              { length: 20 },
              (_, index) => `${scope}/${(offset + index).toString().padStart(3, '0')}`
            )
          );
          for (const row of rows)
            db.delete(historyImport).where(eq(historyImport.entity_id, row.entity_id)).run();
        }
        expect(batch.all()).toEqual([]);
      }
    });
  });

  it('stages root history without overwriting fresher live rows or tombstones', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', { info: message(kiloSessionId, 'msg_live', 20) });
    await publish(stub, 'message.part.updated', {
      part: part(kiloSessionId, 'msg_live', 'prt_live', 'fresh'),
    });
    await publish(stub, 'message.removed', { sessionID: kiloSessionId, messageID: 'msg_removed' });
    await runInDurableObject(stub, async (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      state.storage.kv.delete('client_history_hydration');
      const ingest = {
        getCloudAgentRootSessionSnapshot: vi.fn().mockResolvedValue({
          kiloSessionId,
          cloudAgentSessionId: sessionId,
          snapshot: { kind: 'value', info: snapshot(kiloSessionId), byteLength: 1 },
        }),
        getCloudAgentRootSessionMessages: vi.fn().mockResolvedValue({
          kiloSessionId,
          cloudAgentSessionId: sessionId,
          history: {
            messages: [
              {
                info: message(kiloSessionId, 'msg_live', 20),
                parts: [part(kiloSessionId, 'msg_live', 'prt_live', 'stale')],
              },
              { info: message(kiloSessionId, 'msg_removed', 5), parts: [] },
              { info: message(kiloSessionId, 'msg_history', 1), parts: [] },
            ],
            nextCursor: null,
            omittedItemCount: 0,
          },
        }),
      } as unknown as SessionIngestBinding;
      await hydrateSessionHistory({
        db: drizzle(state.storage),
        storage: state.storage,
        queries,
        ingest,
        sessionId,
        kiloSessionId,
        userId: USER_ID,
        isCurrent: () => true,
        broadcast: () => undefined,
      });
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_live/prt_live')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'fresh' });
      expect(
        readNativeEventPayload(queries.findByEntityId('message/msg_removed')?.payload ?? '')?.event
      ).toBe('message.removed');
      expect(readHistoryHydration(state.storage)?.phase).toBe('complete');
      expect(drizzle(state.storage).select().from(historyImport).all()).toEqual([]);
    });
    expect((await stub.getSessionMessagesPage())?.messages.map(item => item.info.id)).toEqual([
      'msg_history',
      'msg_live',
    ]);
  });

  it('validates a complete child archive before publishing any staged rows', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const child = nativeId();
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage);
      const queries = createSessionEventQueries(db, state.storage);
      const fetchExport = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            info: snapshot(child),
            messages: [{ info: message(child, 'msg_child_old', 1), parts: [] }],
          }).slice(0, -1)
        )
      );
      const ingest = { fetch: fetchExport } as unknown as SessionIngestBinding;
      const input = {
        db,
        storage: state.storage,
        queries,
        ingest,
        sessionId,
        kiloSessionId: child,
        rootKiloSessionId: kiloSessionId,
        userId: USER_ID,
        internalSecret: 'internal-test-secret',
        isCurrent: () => true,
        broadcast: vi.fn(),
      };
      await expect(hydrateSessionHistory(input)).rejects.toThrow('Incomplete');
      expect(queries.findByEntityId('message/msg_child_old')).toBeNull();
      expect(input.broadcast).not.toHaveBeenCalled();
      const valid = new Response(
        JSON.stringify({
          info: snapshot(child),
          messages: [
            {
              info: message(child, 'msg_child_current', 2),
              parts: [part(child, 'msg_child_current', 'prt_child')],
            },
          ],
        })
      );
      fetchExport.mockResolvedValue(valid);
      await hydrateSessionHistory(input);
      expect(queries.findByEntityId('message/msg_child_old')).toBeNull();
      expect(queries.findByEntityId('message/msg_child_current')).not.toBeNull();
      expect(readHistoryHydration(state.storage, child)?.phase).toBe('complete');
    });
  });

  it('restores full current retry status and bounded commit bootstrap without transcript replay', async () => {
    const { stub, kiloSessionId } = await fixture();
    await publish(stub, 'session.status', {
      sessionID: kiloSessionId,
      status: { type: 'retry', attempt: 3, message: 'retrying', next: 12345 },
    });
    for (let index = 0; index < 105; index += 1)
      await publish(stub, 'autocommit_completed', {
        commitHash: index.toString(16).padStart(40, '0'),
        commitMessage: `commit ${index}`,
        userMessageId: 'msg_commit',
        messageId: `msg_commit_${index}`,
        committedAt: new Date(index + 1).toISOString(),
        pushStatus: 'pushed',
      });
    await runInDurableObject(stub, (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const ancillary = queries.readAncillaryBootstrap();
      expect(ancillary.events).toHaveLength(100);
      expect(ancillary.omittedItemCount).toBe(5);
      expect(new TextEncoder().encode(JSON.stringify(ancillary.events)).byteLength).toBeLessThan(
        1_048_576
      );
      const derive = Reflect.get(instance, 'deriveSessionStatus') as () => unknown;
      expect(derive.call(instance)).toEqual({
        type: 'retry',
        attempt: 3,
        message: 'retrying',
        next: 12345,
      });
    });
  });

  it('never resurrects seed history over live removals and shares one cursor namespace', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage);
      const queries = createSessionEventQueries(db, state.storage);
      persistSessionEvent({
        sessionId,
        queries,
        event: {
          type: 'message.removed',
          properties: { sessionID: kiloSessionId, messageID: 'msg_dead' },
        },
      });
      expect(
        persistSessionEvent({
          sessionId,
          queries,
          seed: true,
          event: {
            type: 'message.updated',
            properties: { info: message(kiloSessionId, 'msg_dead', 1) },
          },
        })
      ).toBeNull();
      const row = db.select().from(eventMutationCursor).where(eq(eventMutationCursor.id, 1)).get();
      expect(row?.cursor).toBe(1);
      markHistoryHydrated(state.storage);
      expect(readHistoryHydration(state.storage)?.phase).toBe('complete');
      expect(db.select().from(events).all()).toHaveLength(1);
    });
  });
});
