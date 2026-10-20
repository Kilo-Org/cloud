/**
 * End-to-end coverage for the /ingest WebSocket across a container billing
 * block: a real CloudAgentSession Durable Object, real hibernatable WebSocket,
 * and real SQLite event rows.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { createEventQueries } from '../../../src/session/queries/events.js';

const WRAPPER_RUN_ID = 'wr_billing_blocked';
const WRAPPER_GENERATION = 1;
const WRAPPER_CONNECTION_ID = 'conn_billing_blocked';

const touchedSessions = new Set<string>();

function sessionStub(userId: string, sessionId: string) {
  const sessionName = `${userId}:${sessionId}`;
  touchedSessions.add(sessionName);
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName));
}

function latestEventId(state: DurableObjectState): number | null {
  const queries = createEventQueries(drizzle(state.storage, { logger: false }), state.storage.sql);
  return queries.getLatestEventId();
}

afterEach(async () => {
  for (const sessionName of touchedSessions) {
    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName)),
      async (instance, state) => {
        try {
          await instance.interruptExecution();
        } catch {
          // A session that never registered has no work to interrupt.
        }
        await state.storage.deleteAlarm();
        // Test-only read of the fire-and-forget publication tail this file must drain.
        const { publicExtensionPublicationTail } = instance as unknown as {
          publicExtensionPublicationTail?: Promise<unknown>;
        };
        await publicExtensionPublicationTail?.catch(() => undefined);
      }
    ).catch(() => undefined);
  }
  touchedSessions.clear();
});

function ingestRequest(sessionId: string): Request {
  const url = new URL('https://example.test/ingest');
  url.searchParams.set('wrapperRunId', WRAPPER_RUN_ID);
  url.searchParams.set('wrapperGeneration', String(WRAPPER_GENERATION));
  url.searchParams.set('wrapperConnectionId', WRAPPER_CONNECTION_ID);
  url.searchParams.set('sessionId', sessionId);
  return new Request(url, { headers: { Upgrade: 'websocket' } });
}

function ingestFrame(streamEventType: string): string {
  return JSON.stringify({
    streamEventType,
    data: {},
    timestamp: new Date().toISOString(),
  });
}

describe('ingest container billing state', () => {
  it('keeps persisting while clear and closes the socket once the stored block appears', async () => {
    const userId = 'user_ingest_billing';
    const sessionId = 'agent_ingest_billing';
    const stub = sessionStub(userId, sessionId);

    const readContainerBillingBlock = vi.fn().mockResolvedValue(false);
    const stopContainerForBillingBlock = vi.fn().mockResolvedValue(undefined);
    const keepContainerAlive = vi.fn().mockResolvedValue(undefined);

    await runInDurableObject(stub, async (instance, state) => {
      const now = Date.now();
      await instance.updateMetadata({ version: now, sessionId, userId, timestamp: now });
      await state.storage.put('wrapper_runtime_state', {
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: WRAPPER_GENERATION,
        wrapperConnectionId: WRAPPER_CONNECTION_ID,
        lastWrapperConnectedAt: now,
      });
      Object.assign(instance, {
        readContainerBillingBlock,
        stopContainerForBillingBlock,
        keepContainerAlive,
      });
    });

    const response = await stub.fetch(ingestRequest(sessionId));
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (!client) throw new Error('/ingest did not return a WebSocket');
    client.accept();

    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      client.addEventListener('close', event =>
        resolve({ code: event.code, reason: event.reason })
      );
    });

    client.send(ingestFrame('autocommit_started'));

    await vi.waitFor(async () => {
      const persisted = await runInDurableObject(stub, (_instance, state) => latestEventId(state));
      expect(persisted).not.toBeNull();
    });
    const persistedWhileClear = await runInDurableObject(stub, (_instance, state) =>
      latestEventId(state)
    );
    expect(stopContainerForBillingBlock).not.toHaveBeenCalled();

    // The accept path renews the sandbox timer; only renewals after the block matter here.
    keepContainerAlive.mockClear();

    await runInDurableObject(stub, async (instance, state) => {
      readContainerBillingBlock.mockResolvedValue(true);
      const [server] = state.getWebSockets(`ingest:${WRAPPER_RUN_ID}`);
      if (!server) throw new Error('accepted ingest socket not found');
      server.serializeAttachment({
        ...(server.deserializeAttachment() as Record<string, unknown>),
        billingCheckedAt: 0,
      });
    });

    client.send(ingestFrame('autocommit_completed'));

    await expect(closed).resolves.toEqual({ code: 4402, reason: 'Container billing blocked' });
    const persistedAfterBlock = await runInDurableObject(stub, (_instance, state) =>
      latestEventId(state)
    );
    expect(persistedAfterBlock).toBe(persistedWhileClear);
    expect(stopContainerForBillingBlock).toHaveBeenCalledOnce();
    expect(keepContainerAlive).not.toHaveBeenCalled();
  });
});
