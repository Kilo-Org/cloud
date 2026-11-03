import { describe, it, expect, vi } from 'vitest';
import type * as SessionEvents from './session-events';

// Mock cloudflare:workers before any imports that might pull in DO code
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('./dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

vi.mock('./dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(),
}));

vi.mock('./session-events', async importOriginal => {
  const actual = await importOriginal<typeof SessionEvents>();
  return {
    ...actual,
    notifyUserSessionEvent: vi.fn(),
  };
});

// Small limits so one payload exercises the chunk byte budget and both fail-closed
// paths, while MAX_SINGLE_ITEM_BYTES stays above the projected-item budget.
vi.mock('./util/ingest-limits', () => ({
  INGEST_CHUNK_MAX_BYTES: 300,
  INGEST_CHUNK_MAX_ITEMS: 128,
  MAX_INGEST_ITEM_BYTES: 100,
  MAX_SINGLE_ITEM_BYTES: 20_000,
}));

import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { queue } from './queue-consumer';

const encoder = new TextEncoder();

function mockSessionRow(sessionId: string) {
  const limit = vi.fn(async () => [{ session_id: sessionId }]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => ({ from })) } as never);
}

function mockIngestWithR2(ingest: ReturnType<typeof vi.fn>) {
  vi.mocked(getSessionIngestDO).mockImplementation(
    env =>
      ({
        ingest,
        stageR2Object: async (
          params: { key: string },
          body: ReadableStream<Uint8Array> | Uint8Array
        ) => {
          await env.SESSION_INGEST_R2.put(params.key, body);
          return true;
        },
      }) as never
  );
}

type Item = { type: string; data: Record<string, unknown> };

async function runQueue(items: Item[], ingest: ReturnType<typeof vi.fn>) {
  const sessionId = 'ses_budget';
  mockSessionRow(sessionId);
  mockIngestWithR2(ingest);
  const body = JSON.stringify({ data: items });
  const put = vi.fn(async (_key: string, _body: ReadableStream<Uint8Array>) => undefined);
  const env = {
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    SESSION_INGEST_R2: {
      get: vi.fn(async () => new Response(body)),
      put,
      delete: vi.fn(async () => undefined),
    },
  } as never;
  const ack = vi.fn();
  const retry = vi.fn();
  const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

  await queue(
    {
      messages: [
        {
          body: {
            r2Key: 'staging/budget',
            kiloUserId: 'usr_budget',
            sessionId,
            ingestVersion: 1,
            ingestedAt: 456,
          },
          ack,
          retry,
        },
      ],
    } as never,
    env,
    ctx
  );

  return { put, ack, retry };
}

function sentChunks(ingest: ReturnType<typeof vi.fn>): Item[][] {
  return ingest.mock.calls.map(call => call[0] as Item[]);
}

/** Data of a message item that stays under MAX_INGEST_ITEM_BYTES (100). */
function inlineMessage(index: number): Item {
  return { type: 'message', data: { id: `msg_${index}`, content: 'x'.repeat(70) } };
}

describe('queue consumer RPC budget', () => {
  it('flushes a chunk before an added item would exceed the byte budget', async () => {
    const ingest = vi.fn(async () => ({ changes: [] }));
    const items = Array.from({ length: 7 }, (_, index) => inlineMessage(index));

    const { ack } = await runQueue(items, ingest);

    const chunks = sentChunks(ingest);
    // Two ~123-byte items plus their identities and separators fit one 300-byte chunk;
    // a third would not, so the chunk is flushed before it is added.
    expect(chunks.map(chunk => chunk.length)).toEqual([2, 2, 2, 1]);
    for (const chunk of chunks) {
      expect(encoder.encode(JSON.stringify(chunk)).byteLength).toBeLessThanOrEqual(300);
    }
    expect(chunks.flat()).toEqual(items);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('skips a single item larger than one ingest RPC and keeps the rest of the batch', async () => {
    const ingest = vi.fn(async () => ({ changes: [] }));
    const oversized = { type: 'session', data: { title: 'x'.repeat(5000) } };
    const message = inlineMessage(0);

    const { put, ack, retry } = await runQueue([oversized, message], ingest);

    // The item is dropped before its data is staged, so no orphaned R2 object is written.
    expect(put).not.toHaveBeenCalled();
    expect(sentChunks(ingest)).toEqual([[message]]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });

  it('skips an item whose projection cannot be bounded and keeps the rest of the batch', async () => {
    const ingest = vi.fn(async () => ({ changes: [] }));
    const unbounded = { type: 'session', data: { title: 'x'.repeat(9000) } };
    const message = inlineMessage(0);

    const { put, ack, retry } = await runQueue([unbounded, message], ingest);

    expect(put).not.toHaveBeenCalled();
    expect(sentChunks(ingest)).toEqual([[message]]);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
