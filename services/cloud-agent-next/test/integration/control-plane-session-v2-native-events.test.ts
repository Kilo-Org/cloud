import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { createSessionEventQueries } from '../../src/control-plane/session/event-queries.js';
import { readNativeEventPayload } from '../../src/control-plane/session/native-events.js';
import { PART_TEXT_FLUSH_MS } from '../../src/control-plane/session/part-text-buffer.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type {
  ControlPlaneEvent,
  ControlPlaneEventsNotification,
} from '../../src/shared/control-plane-protocol.js';

const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;

async function fixture() {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
  const stub = sessions.getByName(sessionId);
  const sandboxId = `ses-${crypto.randomUUID().replaceAll('-', '')}`;
  await stub.registerSessionFromMetadata({
    metadata: parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: { sessionId, userId: 'native-events-user', createdOnPlatform: 'cloud-agent-web' },
      auth: { kiloSessionId, kilocodeToken: 'test-token' },
      agent: { mode: 'code', model: 'test/model' },
      workspace: { sandboxId },
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
      userId: 'native-events-user',
      kiloSessionId,
      kiloToken: 'test-token',
      scopeId: sessionId,
    },
  });
  const part = { id: 'prt_text', sessionID: kiloSessionId, messageID: 'msg_text', type: 'text' };
  const delta = (text: string): ControlPlaneEvent => ({
    type: 'message.part.delta',
    properties: {
      sessionID: kiloSessionId,
      messageID: part.messageID,
      partID: part.id,
      field: 'text',
      delta: text,
    },
  });
  return { stub, sessionId, kiloSessionId, part, delta };
}

function kilo2Events(kiloSessionId: string) {
  const source = {
    version: 'v2',
    session: {
      id: kiloSessionId,
      location: { directory: '/workspace/app' },
      time: { created: 1, updated: 2 },
    },
  };
  const message = (
    content: { type: string; text: string }[],
    completed?: number
  ): ControlPlaneEvent => ({
    type: 'conversation.message.updated',
    properties: {
      sessionID: kiloSessionId,
      source,
      message: {
        id: 'msg_v2',
        type: 'assistant',
        time: { created: 2, ...(completed === undefined ? {} : { completed }) },
        content,
      },
    },
  });
  const native = (type: string, data: Record<string, unknown> = {}): ControlPlaneEvent => ({
    type: 'conversation.event',
    properties: {
      sessionID: kiloSessionId,
      source: { version: 'v2' },
      event: {
        id: `evt_${crypto.randomUUID()}`,
        type,
        data: { sessionID: kiloSessionId, assistantMessageID: 'msg_v2', ...data },
      },
    },
  });
  const delta = (kind: 'text' | 'reasoning', text: string) =>
    native(`session.${kind}.delta`, { ordinal: 0, delta: text });
  return { message, native, delta };
}

function storedMessage(state: DurableObjectState) {
  const row = createSessionEventQueries(drizzle(state.storage), state.storage).findByEntityId(
    'message/msg_v2'
  );
  const payload = row === null ? undefined : JSON.parse(row.payload);
  return { row, message: payload?.properties.message };
}

afterEach(async () => {
  await reset();
});

describe('native event delivery', () => {
  it('broadcasts unslimmed live payloads while persisting slim replay rows', async () => {
    const { stub, part } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const broadcast = vi.spyOn(instance, 'broadcast');
      const tool = {
        ...part,
        type: 'tool',
        patch: 'live patch',
        metadata: { diff: 'live diff' },
        state: { status: 'completed', metadata: { diff: 'tool diff', sessionId: 'ses_child' } },
      };
      const info = {
        id: 'msg_text',
        sessionID: part.sessionID,
        summary: { title: 'summary', diffs: [{ file: 'file.ts', patch: 'summary diff' }] },
      };
      await instance.onEvents({
        events: [
          { type: 'message.part.updated', properties: { part: tool } },
          { type: 'message.updated', properties: { info } },
        ],
      });
      expect(JSON.parse(broadcast.mock.calls[0][0].payload).properties.part).toEqual(tool);
      expect(JSON.parse(broadcast.mock.calls[1][0].payload).properties.info).toEqual(info);
      const storedPart = queries.findByEntityId('part/msg_text/prt_text');
      const storedMessage = queries.findByEntityId('message/msg_text');
      expect(readNativeEventPayload(storedPart?.payload ?? '')?.properties.part).toEqual({
        ...part,
        type: 'tool',
        state: { status: 'completed', metadata: { sessionId: 'ses_child' } },
      });
      expect(readNativeEventPayload(storedMessage?.payload ?? '')?.properties.info).toEqual({
        ...info,
        summary: { title: 'summary' },
      });
      expect(broadcast.mock.calls[0][0].mutation_cursor).toBe(storedPart?.mutation_cursor);
      expect(broadcast.mock.calls[1][0].mutation_cursor).toBe(storedMessage?.mutation_cursor);
    });
  });

  it('delivers native events it cannot key live without persisting them', async () => {
    const { stub, part } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const broadcast = vi.spyOn(instance, 'broadcast');
      const events: ControlPlaneEvent[] = [
        {
          type: 'message.part.delta',
          properties: {
            sessionID: part.sessionID,
            messageID: part.messageID,
            partID: part.id,
            delta: 'unfielded',
          },
        },
        { type: 'message.updated', properties: { info: { sessionID: part.sessionID } } },
      ];
      await instance.onEvents({ events });
      expect(broadcast.mock.calls.map(([event]) => event.id)).toEqual([0, 0]);
      expect(broadcast.mock.calls.map(([event]) => JSON.parse(event.payload))).toEqual(
        events.map(event => ({ ...event, event: event.type }))
      );
      expect(queries.findByFilters({})).toEqual([]);
      expect(queries.getUpdateCursor()).toBe(0);
    });
  });

  it('does not append deltas twice after an ambiguous batched RPC retry or eviction', async () => {
    const { stub, sessionId, part, delta } = await fixture();
    const sandbox = sandboxes.getByName(`native-events-${crypto.randomUUID()}`);
    const calls: ControlPlaneEventsNotification[] = [];
    const expiresAt = Date.now() + 60_000;
    await runInDurableObject(sandbox, async instance => {
      await instance.getAllocationState();
      const target = instance.env.SANDBOX_SESSION.getByName(sessionId);
      vi.spyOn(instance, 'requireOwner').mockResolvedValue('native-events-user');
      vi.spyOn(instance, 'sessionPeerFor').mockReturnValue({
        async onEvents(notification: ControlPlaneEventsNotification) {
          calls.push(notification);
          await target.onEvents(notification);
          if (calls.length === 1)
            throw Object.assign(new Error('response lost'), { retryable: true });
        },
      } as never);
      await instance.notifySession(
        sessionId,
        { kind: 'events', payload: { events: [delta('same'), delta('same'), delta(' suffix')] } },
        expiresAt,
        new AbortController().signal
      );
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].delivery).toEqual({ id: expect.any(String), expiresAt });
    expect(calls[1].delivery).toEqual(calls[0].delivery);
    // A read writes the buffered text, so eviction keeps it.
    await stub.getSession();
    await evictAllDurableObjects();
    await stub.onEvents(calls[0]);
    await stub.onEvents({
      events: [
        { type: 'message.part.updated', properties: { part: { ...part, time: { end: 10 } } } },
      ],
    });
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const row = queries.findByEntityId('part/msg_text/prt_text');
      expect(readNativeEventPayload(row?.payload ?? '')?.properties.part).toMatchObject({
        text: 'samesame suffix',
        time: { end: 10 },
      });
      expect(queries.getUpdateCursor()).toBe(5);
    });
  });

  it('retries only the unapplied suffix after partial batch failure and keeps live deltas', async () => {
    const { stub, delta } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const batch = {
        delivery: { id: crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
        events: [delta('first'), delta('second')],
      };
      const broadcast = vi.spyOn(instance, 'broadcast');
      const advance = vi.spyOn(instance.eventQueries, 'advanceCursor');
      advance.mockImplementationOnce(() => {
        queries.advanceCursor();
        throw new Error('second write failed');
      });
      await expect(instance.onEvents(batch)).rejects.toThrow('second write failed');
      expect(queries.getUpdateCursor()).toBe(1);
      await instance.getSession();
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'first' });
      advance.mockRestore();
      await instance.onEvents(batch);
      expect(broadcast.mock.calls.map(([event]) => JSON.parse(event.payload))).toEqual(
        batch.events.map(event => ({ ...event, event: event.type }))
      );
      expect(queries.getUpdateCursor()).toBe(2);
      await instance.getSession();
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'firstsecond' });
    });
  });

  it('restores buffered text when the event transaction rolls back', async () => {
    const { stub, part, delta } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const text = () =>
        (
          readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
            ?.properties.part as { text?: string } | undefined
        )?.text;
      await instance.onEvents({
        events: [{ type: 'message.part.updated', properties: { part: { ...part, text: 'x' } } }],
      });
      const other = { ...part, id: 'prt_other', text: 'o' };
      const batch = {
        delivery: { id: crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
        events: [
          delta('y'),
          { type: 'message.part.updated', properties: { part: other } },
          delta('z'),
        ] satisfies ControlPlaneEvent[],
      };
      const put = state.storage.kv.put.bind(state.storage.kv);
      // Fail each receipt write once: the delta's, then the flushing event's, then the next delta's.
      const failed = new Set<unknown>();
      const receipt = vi.spyOn(state.storage.kv, 'put').mockImplementation((key, value) => {
        if (key.startsWith('native_event_receipt/') && !failed.has(value)) {
          failed.add(value);
          throw new Error('receipt write failed');
        }
        put(key, value);
      });
      for (let attempt = 0; attempt < 3; attempt++)
        await expect(instance.onEvents(batch)).rejects.toThrow('receipt write failed');
      await instance.onEvents(batch);
      receipt.mockRestore();
      await instance.getSession();
      expect(text()).toBe('xyz');
    });
  });

  it('gives each delta a new cursor and writes the part only when it flushes', async () => {
    const { stub, part, delta } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const stored = () => queries.findByEntityId('part/msg_text/prt_text');
      const broadcast = vi.spyOn(instance, 'broadcast');
      await instance.onEvents({
        events: [{ type: 'message.part.updated', properties: { part: { ...part, text: '' } } }],
      });
      const row = stored();
      for (const text of ['a', 'b', 'c']) await instance.onEvents({ events: [delta(text)] });
      expect(broadcast.mock.calls.map(([event]) => [event.id, event.mutation_cursor])).toEqual([
        [row?.id, 1],
        [row?.id, 2],
        [row?.id, 3],
        [row?.id, 4],
      ]);
      expect(stored()).toEqual(row);
      const session = await instance.getSession();
      expect(stored()).toMatchObject({ id: row?.id, mutation_cursor: 5 });
      expect(readNativeEventPayload(stored()?.payload ?? '')?.properties.part).toEqual({
        ...part,
        text: 'abc',
      });
      expect(session).toMatchObject({ updateCursor: 5 });
    });
  });

  it('writes buffered text without a read once the flush interval passes', async () => {
    const { stub, part, delta } = await fixture();
    await stub.onEvents({
      events: [
        { type: 'message.part.updated', properties: { part: { ...part, text: 'x' } } },
        delta('y'),
      ],
    });
    await new Promise(resolve => setTimeout(resolve, PART_TEXT_FLUSH_MS + 200));
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'xy' });
    });
  });

  it('writes buffered text before a removal so a later flush cannot restore the part', async () => {
    const { stub, part, delta } = await fixture();
    await stub.onEvents({
      events: [
        { type: 'message.part.updated', properties: { part: { ...part, text: 'x' } } },
        delta('y'),
        {
          type: 'message.part.removed',
          properties: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
        },
        delta('z'),
      ],
    });
    await stub.getSession();
    await runInDurableObject(stub, (_instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const row = queries.findByEntityId('part/msg_text/prt_text');
      expect(readNativeEventPayload(row?.payload ?? '')?.event).toBe('message.part.removed');
      // part, delta, flush before the removal, removal; the late delta is dropped.
      expect(row?.mutation_cursor).toBe(4);
      expect(queries.getUpdateCursor()).toBe(4);
    });
  });

  it('extends the last written text with new cursors after a restart', async () => {
    const { stub, part, delta } = await fixture();
    await stub.onEvents({
      events: [
        { type: 'message.part.updated', properties: { part: { ...part, text: 'x' } } },
        delta('maybe'),
      ],
    });
    await evictAllDurableObjects();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const broadcast = vi.spyOn(instance, 'broadcast');
      await instance.onEvents({ events: [delta('z')] });
      // The lost delta took cursor 2; a restart must not reuse it.
      expect(broadcast.mock.calls[0][0].mutation_cursor).toBeGreaterThan(2);
      await instance.getSession();
      // Unflushed text is lost on restart unless the flush timer already ran.
      const stored = readNativeEventPayload(
        queries.findByEntityId('part/msg_text/prt_text')?.payload ?? ''
      )?.properties.part as { text?: string } | undefined;
      expect(['xz', 'xmaybez']).toContain(stored?.text);
    });
  });

  it('gives each kilo2 delta a new cursor and writes the message only when it flushes', async () => {
    const { stub, kiloSessionId } = await fixture();
    const { message, delta } = kilo2Events(kiloSessionId);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onEvents({
        events: [
          message([
            { type: 'reasoning', text: '' },
            { type: 'text', text: '' },
          ]),
        ],
      });
      const { row } = storedMessage(state);
      const broadcast = vi.spyOn(instance, 'broadcast');
      for (const event of [
        delta('reasoning', 'r1'),
        delta('text', 'a'),
        delta('text', 'b'),
        delta('reasoning', 'r2'),
      ])
        await instance.onEvents({ events: [event] });
      expect(broadcast.mock.calls.map(([event]) => [event.id, event.mutation_cursor])).toEqual([
        [row?.id, 2],
        [row?.id, 3],
        [row?.id, 4],
        [row?.id, 5],
      ]);
      expect(storedMessage(state).row).toEqual(row);
      await instance.getSession();
      const flushed = storedMessage(state);
      expect(flushed.row).toMatchObject({ id: row?.id, mutation_cursor: 6 });
      expect(flushed.message.content).toEqual([
        { type: 'reasoning', text: 'r1r2' },
        { type: 'text', text: 'ab' },
      ]);
    });
  });

  it('does not write the kilo2 message for a native event that touches no row', async () => {
    const { stub, kiloSessionId } = await fixture();
    const { message, native, delta } = kilo2Events(kiloSessionId);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.onEvents({ events: [message([{ type: 'text', text: '' }])] });
      const { row } = storedMessage(state);
      await instance.onEvents({
        events: [delta('text', 'a'), native('session.step.started'), delta('text', 'b')],
      });
      expect(storedMessage(state).row).toEqual(row);
      await instance.getSession();
      expect(storedMessage(state).message.content).toEqual([{ type: 'text', text: 'ab' }]);
    });
  });

  it('does not restore buffered kilo2 text over a completed message', async () => {
    const { stub, kiloSessionId } = await fixture();
    const { message, delta } = kilo2Events(kiloSessionId);
    await stub.onEvents({
      events: [
        message([{ type: 'text', text: '' }]),
        delta('text', 'old'),
        message([{ type: 'text', text: 'final' }], 3),
        delta('text', 'late'),
      ],
    });
    await new Promise(resolve => setTimeout(resolve, PART_TEXT_FLUSH_MS + 200));
    await runInDurableObject(stub, (_instance, state) => {
      expect(storedMessage(state).message).toMatchObject({
        time: { completed: 3 },
        content: [{ type: 'text', text: 'final' }],
      });
    });
  });

  it('applies late deliveries once and rejects deliveries past receipt retention', async () => {
    const { stub, delta } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const retainedFrom = Date.now() - 5 * 60_000;
      const staleKey = `native_event_receipt/${String(retainedFrom - 1).padStart(16, '0')}/${crypto.randomUUID()}`;
      state.storage.kv.put(staleKey, 1);
      await instance.onEvents({
        delivery: { id: crypto.randomUUID(), expiresAt: retainedFrom - 1 },
        events: [delta('stale')],
      });
      expect(state.storage.kv.get(staleKey)).toBeUndefined();
      expect(queries.getUpdateCursor()).toBe(0);
      const late = {
        delivery: { id: crypto.randomUUID(), expiresAt: Date.now() - 1 },
        events: [delta('late')],
      };
      await instance.onEvents(late);
      await instance.onEvents(late);
      expect(queries.getUpdateCursor()).toBe(1);
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'late' });
    });
  });
});
