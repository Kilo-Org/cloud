import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ControlPlaneSandboxPeer,
  SandboxSessionV2,
} from '../../src/control-plane/session/session-do.js';
import { createSessionEventQueries } from '../../src/control-plane/session/event-queries.js';
import {
  COST_BACKFILL_BYTE_BUDGET,
  COST_BACKFILL_ROW_LIMIT,
} from '../../src/control-plane/session/cost-total.js';
import {
  costBackfillState,
  events,
  sessionCostTotals,
} from '../../src/control-plane/session/sqlite-schema.js';
import { persistSessionEvent } from '../../src/control-plane/session/native-events.js';
import { hydrateSessionHistory } from '../../src/control-plane/session/history-hydration.js';
import { createPartTextBuffer } from '../../src/control-plane/session/part-text-buffer.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { sessionDoName } from '../../src/session-identity.js';
import type { SessionIngestBinding } from '../../src/session-ingest-binding.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import { seedRegistration } from './helpers/seed-registration.js';

const USER_ID = 'cost-user';
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
      workspace: { sandboxId, branchName: 'kilo/cost' },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await seedRegistration(stub, {
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
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
  return { stub, sessionId, kiloSessionId, peer };
}

async function publish(
  stub: DurableObjectStub<SandboxSessionV2>,
  type: string,
  properties: Record<string, unknown>
) {
  await stub.onEvents({ events: [{ type, properties }] });
}

function assistantInfo(sessionID: string, id: string, created: number, cost?: unknown) {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created },
    ...(cost === undefined ? {} : { cost }),
  };
}

function nativeSource(kiloSessionId: string) {
  return {
    version: 'v2',
    session: {
      id: kiloSessionId,
      location: { directory: '/workspace/app' },
      time: { created: 1, updated: 2 },
    },
  };
}

/** Raw rows bypass the write path, exactly like history stored before the total existed. */
async function seedStoredHistory(
  stub: DurableObjectStub<SandboxSessionV2>,
  sessionId: string,
  kiloSessionId: string,
  assistantCount: number,
  partCount = 0,
  partText = 'x'.repeat(2048)
) {
  await runInDurableObject(stub, (_instance, state) => {
    const db = drizzle(state.storage);
    const rows: (typeof events.$inferInsert)[] = [];
    for (let index = 0; index < assistantCount; index += 1) {
      rows.push({
        execution_id: '',
        session_id: sessionId,
        stream_event_type: 'kilocode',
        payload: JSON.stringify({
          type: 'message.updated',
          event: 'message.updated',
          properties: { info: assistantInfo(kiloSessionId, `msg_a_${index}`, index, 0.25) },
        }),
        timestamp: index,
        entity_id: `message/msg_a_${index}`,
        mutation_cursor: index + 1,
      });
    }
    for (let index = 0; index < partCount; index += 1) {
      rows.push({
        execution_id: '',
        session_id: sessionId,
        stream_event_type: 'kilocode',
        payload: JSON.stringify({
          type: 'message.part.updated',
          event: 'message.part.updated',
          properties: {
            part: {
              id: `prt_${index}`,
              sessionID: kiloSessionId,
              messageID: `msg_a_${index}`,
              type: 'text',
              text: partText,
            },
          },
        }),
        timestamp: index,
        entity_id: `part/msg_a_${index}/prt_${index}`,
        mutation_cursor: assistantCount + index + 1,
      });
    }
    // DO SQLite caps bound parameters per statement well below desktop SQLite.
    for (let index = 0; index < rows.length; index += 12)
      db.insert(events)
        .values(rows.slice(index, index + 12))
        .run();
  });
}

/** The pre-change full scan, kept verbatim as the parity reference. */
function referenceTotalMicrodollars(
  state: DurableObjectState,
  sessionId: string,
  kiloSessionId: string
): number {
  const native = `json_extract(payload, '$.event') = 'conversation.message.updated'`;
  const amount = `case when ${native} then json_extract(payload, '$.properties.message.cost') else json_extract(payload, '$.properties.info.cost') end`;
  const { cost } = state.storage.sql
    .exec<{ cost: number }>(
      `select coalesce(sum(case when typeof(${amount}) in ('integer', 'real') then max(0, ${amount}) else 0 end), 0) as cost
       from events
       where session_id = ?1 and +stream_event_type = 'kilocode'
         and entity_id >= 'message/' and entity_id < 'message0'
         and json_extract(payload, '$.event') in ('message.updated', 'conversation.message.updated')
         and case when ${native} then json_extract(payload, '$.properties.sessionID') else json_extract(payload, '$.properties.info.sessionID') end = ?2
         and case when ${native} then json_extract(payload, '$.properties.message.type') else json_extract(payload, '$.properties.info.role') end = 'assistant'`,
      sessionId,
      kiloSessionId
    )
    .one();
  return Number.isFinite(cost)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(cost * 1_000_000)))
    : 0;
}

type SqlExec = DurableObjectState['storage']['sql']['exec'];

/** Records every events select run inside the callback, with its plan and rows read. */
async function measureEventReads<T>(
  state: DurableObjectState,
  read: () => Promise<T>
): Promise<{ result: T; rowsRead: number; queries: string[]; plans: string[] }> {
  const exec = state.storage.sql.exec.bind(state.storage.sql);
  const captured: { query: string; params: unknown[]; cursor: ReturnType<SqlExec> }[] = [];
  state.storage.sql.exec = ((query: string, ...params: unknown[]) => {
    const cursor = exec(query, ...params);
    if (/^select/i.test(query) && query.includes('"events"'))
      captured.push({ query, params, cursor });
    return cursor;
  }) as SqlExec;
  try {
    const result = await read();
    return {
      result,
      rowsRead: captured.reduce((total, entry) => total + entry.cursor.rowsRead, 0),
      queries: captured.map(entry => entry.query),
      plans: captured.map(entry =>
        [...exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${entry.query}`, ...entry.params)]
          .map(row => row.detail)
          .join(' | ')
      ),
    };
  } finally {
    state.storage.sql.exec = exec;
  }
}

function backfillOf(stub: DurableObjectStub<SandboxSessionV2>) {
  return runInDurableObject(stub, (_instance, state) =>
    drizzle(state.storage).select().from(costBackfillState).get()
  );
}

afterEach(async () => {
  await reset();
});

describe('durable session cost total', () => {
  it('reads large stored history through a bounded backfill, then without rescanning rows', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const assistants = 5000;
    await seedStoredHistory(stub, sessionId, kiloSessionId, assistants, 1000);
    const fullTotal = assistants * 250_000;

    const first = await runInDurableObject(stub, (instance, state) =>
      measureEventReads(state, () => instance.getSession())
    );
    expect(first.rowsRead).toBeLessThanOrEqual(2 * COST_BACKFILL_ROW_LIMIT + 64);
    expect(first.result).toMatchObject({
      totalCostMicrodollars: COST_BACKFILL_ROW_LIMIT * 250_000,
    });
    expect(first.plans.some(plan => /SCAN events\b/.test(plan))).toBe(false);
    expect(await backfillOf(stub)).toMatchObject({ cursor: COST_BACKFILL_ROW_LIMIT, complete: 0 });

    const converged = await runInDurableObject(stub, async (instance, state) => {
      let snapshot = await instance.getSession();
      for (
        let attempt = 0;
        attempt < 8 &&
        drizzle(state.storage).select().from(costBackfillState).get()?.complete !== 1;
        attempt += 1
      )
        snapshot = await instance.getSession();
      return snapshot;
    });
    expect(converged).toMatchObject({ totalCostMicrodollars: fullTotal });

    const steady = await runInDurableObject(stub, (instance, state) =>
      measureEventReads(state, async () => ({
        snapshot: await instance.getSession(),
        summary: await instance.getSessionMetadataSummary(),
      }))
    );
    expect(steady.result.snapshot).toMatchObject({ totalCostMicrodollars: fullTotal });
    expect(steady.result.summary.snapshot).toMatchObject({ totalCostMicrodollars: fullTotal });
    // Steady metadata reads touch only single-row lookups; the cost scan is gone.
    expect(steady.rowsRead).toBeLessThan(64);
    expect(steady.queries.some(query => query.includes('sum('))).toBe(false);
    expect(steady.plans.some(plan => /SCAN events\b/.test(plan))).toBe(false);

    const page = await runInDurableObject(stub, (instance, state) =>
      measureEventReads(state, () => instance.getSessionMessagesPage({ limit: 1 }))
    );
    expect(page.result?.totalCostMicrodollars).toBe(fullTotal);
    expect(page.queries.some(query => query.includes('$.properties.info.cost'))).toBe(false);
  });

  it('stops at the byte budget for part rows and resumes without losing message cost', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const partText = 'é'.repeat((COST_BACKFILL_BYTE_BUDGET * 3) / 16);
    await seedStoredHistory(stub, sessionId, kiloSessionId, 0, 3, partText);
    await seedStoredHistory(stub, sessionId, kiloSessionId, 1);

    expect(await stub.getSession()).toMatchObject({ totalCostMicrodollars: 0 });
    expect(await backfillOf(stub)).toMatchObject({ cursor: 2, complete: 0 });

    const { summary, reference } = await runInDurableObject(stub, async (instance, state) => ({
      summary: await instance.getSessionMetadataSummary(),
      reference: referenceTotalMicrodollars(state, sessionId, kiloSessionId),
    }));
    expect(reference).toBe(250_000);
    expect(summary.snapshot).toMatchObject({ totalCostMicrodollars: reference });
    expect(await backfillOf(stub)).toMatchObject({ cursor: 4, complete: 1 });
  });

  it('serves the committed total when backfill fails and retries the same rows', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await seedStoredHistory(stub, sessionId, kiloSessionId, COST_BACKFILL_ROW_LIMIT + 1);
    const partialTotal = COST_BACKFILL_ROW_LIMIT * 250_000;
    expect(await stub.getSession()).toMatchObject({ totalCostMicrodollars: partialTotal });
    const cursorBeforeFailure = await backfillOf(stub);

    const summary = await runInDurableObject(stub, async (instance, state) => {
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      state.storage.sql.exec = ((query: string, ...params: unknown[]) => {
        if (query.startsWith('insert into "cost_backfill_state"')) {
          throw new Error('Backfill cursor write failed');
        }
        return exec(query, ...params);
      }) as SqlExec;
      try {
        return await instance.getSessionMetadataSummary();
      } finally {
        state.storage.sql.exec = exec;
      }
    });
    expect(summary.snapshot).toMatchObject({ totalCostMicrodollars: partialTotal });
    expect(await backfillOf(stub)).toEqual(cursorBeforeFailure);

    expect(await stub.getSession()).toMatchObject({
      totalCostMicrodollars: partialTotal + 250_000,
    });
    expect(await backfillOf(stub)).toMatchObject({
      cursor: COST_BACKFILL_ROW_LIMIT + 1,
      complete: 1,
    });
  });

  it('resumes the backfill after eviction and counts writes made while it runs', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await seedStoredHistory(stub, sessionId, kiloSessionId, 5000);
    await runInDurableObject(stub, async instance => {
      await instance.getSession();
    });
    expect(await backfillOf(stub)).toMatchObject({ cursor: COST_BACKFILL_ROW_LIMIT, complete: 0 });

    // A counted row changes cost; a brand-new row lands ahead of the cursor.
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      queries.upsert({
        executionId: '',
        sessionId,
        streamEventType: 'kilocode',
        entityId: 'message/msg_a_0',
        timestamp: 1,
        payload: JSON.stringify({
          type: 'message.updated',
          event: 'message.updated',
          properties: { info: assistantInfo(kiloSessionId, 'msg_a_0', 0, 0.75) },
        }),
      });
    });
    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_new_during_backfill', 6000, 0.5),
    });
    await evictAllDurableObjects();
    expect(await backfillOf(stub)).toMatchObject({ cursor: COST_BACKFILL_ROW_LIMIT, complete: 0 });

    const final = await runInDurableObject(stub, async (instance, state) => {
      let snapshot = await instance.getSession();
      for (
        let attempt = 0;
        attempt < 8 &&
        drizzle(state.storage).select().from(costBackfillState).get()?.complete !== 1;
        attempt += 1
      )
        snapshot = await instance.getSession();
      return { snapshot, reference: referenceTotalMicrodollars(state, sessionId, kiloSessionId) };
    });
    expect(final.snapshot).toMatchObject({ totalCostMicrodollars: 1_251_000_000 });
    expect(final.reference).toBe(1_251_000_000);
  });

  it('keeps the total exact through live writes, replacements, removals, and both shapes', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    const child = nativeId();
    const source = nativeSource(kiloSessionId);
    const expectParity = async (label: string) => {
      const { stored, reference } = await runInDurableObject(stub, (_instance, state) => {
        const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
        return {
          stored: queries.getTotalCostMicrodollars(sessionId, kiloSessionId),
          reference: referenceTotalMicrodollars(state, sessionId, kiloSessionId),
        };
      });
      expect(stored, label).toBe(reference);
      return stored;
    };

    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_v1', 1, 0.25),
    });
    expect(await expectParity('v1 insert')).toBe(250_000);

    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_v1', 1, 0.5),
    });
    expect(await expectParity('v1 replacement')).toBe(500_000);

    await publish(stub, 'message.updated', {
      info: {
        id: 'msg_user',
        sessionID: kiloSessionId,
        role: 'user',
        time: { created: 2 },
        cost: 99,
      },
    });
    expect(await expectParity('user excluded')).toBe(500_000);

    await publish(stub, 'conversation.source', { sessionID: kiloSessionId, source });
    await publish(stub, 'conversation.message.updated', {
      sessionID: kiloSessionId,
      source,
      message: { id: 'msg_native', type: 'assistant', time: { created: 3 }, cost: 0.125 },
    });
    expect(await expectParity('native insert')).toBe(625_000);

    await publish(stub, 'conversation.message.updated', {
      sessionID: kiloSessionId,
      source,
      message: { id: 'msg_native', type: 'assistant', time: { created: 3 }, cost: 0.375 },
    });
    expect(await expectParity('native replacement')).toBe(875_000);

    await publish(stub, 'session.created', { info: { id: child, parentID: kiloSessionId } });
    await publish(stub, 'message.updated', {
      info: assistantInfo(child, 'msg_child', 4, 1),
    });
    expect(await expectParity('child scope isolated')).toBe(875_000);
    const childTotal = await runInDurableObject(stub, (_instance, state) =>
      createSessionEventQueries(drizzle(state.storage), state.storage).getTotalCostMicrodollars(
        sessionId,
        child
      )
    );
    expect(childTotal).toBe(1_000_000);

    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_edges', 5, -3),
    });
    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_string_cost', 6, '0.5'),
    });
    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_bool_cost', 7, true),
    });
    expect(await expectParity('negative, string, boolean costs')).toBe(1_875_000);

    await publish(stub, 'message.removed', { sessionID: kiloSessionId, messageID: 'msg_v1' });
    expect(await expectParity('removal replaces the cost row')).toBe(1_375_000);

    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_huge', 8, 1e12),
    });
    expect(await expectParity('clamp')).toBe(Number.MAX_SAFE_INTEGER);
    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_huge', 8, 0.25),
    });
    expect(await expectParity('clamp released')).toBe(1_625_000);

    const snapshot = await stub.getSession();
    const summary = await runInDurableObject(stub, instance =>
      instance.getSessionMetadataSummary()
    );
    expect(snapshot).toMatchObject({ totalCostMicrodollars: 1_625_000 });
    expect(summary.snapshot).toMatchObject({ totalCostMicrodollars: 1_625_000 });
  });

  it('replays idempotent deliveries and history imports without double counting', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const partText = createPartTextBuffer({
        queries,
        onFlushError: error => {
          throw error;
        },
      });
      const event = {
        type: 'message.updated',
        properties: { info: assistantInfo(kiloSessionId, 'msg_seed', 1, 0.25) },
      };
      expect(
        persistSessionEvent({ sessionId, event, queries, partText, seed: true })
      ).not.toBeNull();
      expect(persistSessionEvent({ sessionId, event, queries, partText, seed: true })).toBeNull();
      expect(queries.getTotalCostMicrodollars(sessionId, kiloSessionId)).toBe(250_000);
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.delete('client_history_hydration');
      const db = drizzle(state.storage);
      const queries = createSessionEventQueries(db, state.storage);
      const ingest = {
        getCloudAgentRootSessionSnapshot: async () => null,
        getCloudAgentRootSessionMessages: async () => ({
          kiloSessionId,
          cloudAgentSessionId: sessionId,
          history: {
            messages: [
              {
                info: {
                  ...assistantInfo(kiloSessionId, 'msg_imported', 2, 0.5),
                  parentID: 'msg_parent',
                  modelID: 'test/model',
                  providerID: 'kilo',
                  mode: 'code',
                  agent: 'code',
                  path: { cwd: '/workspace/app', root: '/workspace/app' },
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [],
              },
            ],
            nextCursor: null,
            omittedItemCount: 0,
          },
        }),
      } as unknown as SessionIngestBinding;
      await hydrateSessionHistory({
        db,
        storage: state.storage,
        queries,
        partText: createPartTextBuffer({
          queries,
          onFlushError: error => {
            throw error;
          },
        }),
        ingest,
        sessionId,
        kiloSessionId,
        userId: USER_ID,
        isCurrent: () => true,
        broadcast: () => undefined,
      });
      expect(queries.getTotalCostMicrodollars(sessionId, kiloSessionId)).toBe(750_000);
      expect(referenceTotalMicrodollars(state, sessionId, kiloSessionId)).toBe(750_000);
    });
  });

  it('recovers a poisoned total when an overflowing cost row is replaced', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await runInDurableObject(stub, (_instance, state) => {
      drizzle(state.storage)
        .insert(events)
        .values({
          execution_id: '',
          session_id: sessionId,
          stream_event_type: 'kilocode',
          payload: `{"type":"message.updated","event":"message.updated","properties":{"info":{"id":"msg_overflow","sessionID":"${kiloSessionId}","role":"assistant","time":{"created":1},"cost":1e999}}}`,
          timestamp: 1,
          entity_id: 'message/msg_overflow',
          mutation_cursor: 1,
        })
        .run();
    });
    expect(await stub.getSession()).toMatchObject({ totalCostMicrodollars: 0 });
    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_overflow', 1, 0.25),
    });
    const { stored, reference } = await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      return {
        stored: queries.getTotalCostMicrodollars(sessionId, kiloSessionId),
        reference: referenceTotalMicrodollars(state, sessionId, kiloSessionId),
      };
    });
    expect(stored).toBe(250_000);
    expect(reference).toBe(250_000);
  });

  it('rolls the total back with a failed write transaction', async () => {
    const { stub, sessionId, kiloSessionId } = await fixture();
    await publish(stub, 'message.updated', {
      info: assistantInfo(kiloSessionId, 'msg_stable', 1, 0.25),
    });
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      expect(queries.getTotalCostMicrodollars(sessionId, kiloSessionId)).toBe(250_000);
      expect(() =>
        state.storage.transactionSync(() => {
          queries.upsert({
            executionId: '',
            sessionId,
            streamEventType: 'kilocode',
            entityId: 'message/msg_stable',
            timestamp: 2,
            payload: JSON.stringify({
              type: 'message.updated',
              event: 'message.updated',
              properties: { info: assistantInfo(kiloSessionId, 'msg_stable', 1, 5) },
            }),
          });
          throw new Error('rollback');
        })
      ).toThrow('rollback');
      expect(queries.getTotalCostMicrodollars(sessionId, kiloSessionId)).toBe(250_000);
    });
  });

  it('clears the total and backfill watermark on both session wipe paths', async () => {
    for (const wipePath of ['deleteAll', 'locator'] as const) {
      const { stub, sessionId, kiloSessionId } = await fixture();
      await publish(stub, 'message.updated', {
        info: assistantInfo(kiloSessionId, 'msg_wiped', 1, 0.25),
      });
      expect(await stub.getSession()).toMatchObject({ totalCostMicrodollars: 250_000 });
      await runInDurableObject(stub, async instance => {
        if (wipePath === 'locator') {
          const peer: ControlPlaneSandboxPeer = new FakeSandboxPeer();
          peer.getAcceptedHandleIssuerLocator = async () => ({
            scopeId: sessionId,
            allocationId: 'alloc_cost',
            wrapperInstanceId: 'wrapper_cost',
            expiresAt: Date.now() + 60_000,
          });
          instance.sandboxPeerFor = () => peer;
        }
        await instance['resetSessionStorage']();
      });
      const tables = await runInDurableObject(stub, (_instance, state) => {
        const db = drizzle(state.storage);
        return {
          totals: db.select().from(sessionCostTotals).all(),
          backfill: db.select().from(costBackfillState).all(),
        };
      });
      expect(tables.totals, wipePath).toEqual([]);
      expect(tables.backfill, wipePath).toEqual([]);
      expect(await stub.getSession(), wipePath).toEqual({ type: 'session-not-found' });
    }
  });
});
