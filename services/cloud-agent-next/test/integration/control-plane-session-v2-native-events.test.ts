import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { createSessionEventQueries } from '../../src/control-plane/session/event-queries.js';
import { readNativeEventPayload } from '../../src/control-plane/session/native-events.js';
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
  return { stub, sessionId, part, delta };
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
      expect(queries.getUpdateCursor()).toBe(4);
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
      const upsert = vi.spyOn(instance.eventQueries, 'upsert');
      upsert.mockImplementationOnce(input => queries.upsert(input));
      upsert.mockImplementationOnce(input => {
        queries.upsert(input);
        throw new Error('second write failed');
      });
      await expect(instance.onEvents(batch)).rejects.toThrow('second write failed');
      expect(queries.getUpdateCursor()).toBe(1);
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'first' });
      upsert.mockRestore();
      await instance.onEvents(batch);
      expect(broadcast.mock.calls.map(([event]) => JSON.parse(event.payload))).toEqual(
        batch.events.map(event => ({ ...event, event: event.type }))
      );
      expect(queries.getUpdateCursor()).toBe(2);
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'firstsecond' });
    });
  });

  it('rejects expired retries and prunes expired receipts without affecting active deliveries', async () => {
    const { stub, delta } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const queries = createSessionEventQueries(drizzle(state.storage), state.storage);
      const expiredKey = `native_event_receipt/${String(Date.now() - 1).padStart(16, '0')}/${crypto.randomUUID()}`;
      state.storage.kv.put(expiredKey, 1);
      const expired = {
        delivery: { id: crypto.randomUUID(), expiresAt: Date.now() - 1 },
        events: [delta('expired')],
      };
      await instance.onEvents(expired);
      expect(state.storage.kv.get(expiredKey)).toBeUndefined();
      expect(queries.getUpdateCursor()).toBe(0);
      await instance.onEvents({
        delivery: { id: crypto.randomUUID(), expiresAt: Date.now() + 60_000 },
        events: [delta('current')],
      });
      await instance.onEvents(expired);
      expect(queries.getUpdateCursor()).toBe(1);
      expect(
        readNativeEventPayload(queries.findByEntityId('part/msg_text/prt_text')?.payload ?? '')
          ?.properties.part
      ).toMatchObject({ text: 'current' });
    });
  });
});
