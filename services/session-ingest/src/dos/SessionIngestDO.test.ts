import { describe, expect, it, vi } from 'vitest';

const drizzleMocks = vi.hoisted(() => ({
  db: undefined as unknown,
  migrate: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    ctx: unknown;
    env: unknown;
    constructor(state: unknown, env: unknown) {
      this.ctx = state;
      this.env = env;
    }
  },
}));

vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => drizzleMocks.db),
}));

vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({
  migrate: drizzleMocks.migrate,
}));

import { SessionIngestDO, ingestOrderCursor } from './SessionIngestDO';

describe('SessionIngestDO ingest ordering', () => {
  it('uses ingested_at with id only as a tie-breaker for cursor progression', () => {
    expect(ingestOrderCursor({ ingested_at: 100, id: 7 })).toEqual({ ingestedAt: 100, id: 7 });
    expect(ingestOrderCursor({ ingested_at: null, id: 3 })).toEqual({ ingestedAt: null, id: 3 });
  });

  it('applies same-batch lifecycle markers in payload order', async () => {
    const operations: string[] = [];
    const selectQuery = {
      from: vi.fn(() => selectQuery),
      where: vi.fn(() => selectQuery),
      get: vi.fn(() => undefined),
    };
    const db = {
      select: vi.fn(() => selectQuery),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key?: string; value?: string | null; item_id?: string }) => ({
          onConflictDoUpdate: vi.fn(() => ({
            run: vi.fn(() => {
              if (values.key === 'closeReason') {
                operations.push(`meta:${values.key}:${values.value}`);
              }
            }),
          })),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => ({
          run: vi.fn(() => operations.push('delete:closeReason')),
        })),
      })),
    };
    drizzleMocks.db = db;

    const state = {
      storage: {
        setAlarm: vi.fn(async () => {
          operations.push('alarm');
        }),
      },
      blockConcurrencyWhile: vi.fn((fn: () => void) => fn()),
    } as unknown as DurableObjectState;
    const env = { SESSION_INGEST_R2: { delete: vi.fn() } } as never;

    const durableObject = new SessionIngestDO(state, env);
    await durableObject.ingest(
      [
        { type: 'session_close', data: { reason: 'completed' } },
        { type: 'session_open', data: {} },
      ],
      'usr_order',
      'ses_order',
      1,
      1
    );

    expect(operations).toEqual([
      'meta:closeReason:completed',
      'alarm',
      'delete:closeReason',
      'alarm',
    ]);
  });
});
