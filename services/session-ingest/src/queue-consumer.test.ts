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

vi.mock('./session-events', async importOriginal => {
  const actual = await importOriginal<typeof SessionEvents>();
  return {
    ...actual,
    notifyUserSessionEvent: vi.fn(),
  };
});

// Mock ingest-limits so we can exercise both streaming and SQLite-row compaction thresholds.
vi.mock('./util/ingest-limits', () => ({
  MAX_INGEST_ITEM_BYTES: 100,
  MAX_SINGLE_ITEM_BYTES: 500,
}));

import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { notifyUserSessionEvent } from './session-events';
import { computeSessionMetadataUpdates, createItemExtractor, queue } from './queue-consumer';

const encoder = new TextEncoder();

function feedAll(extractor: ReturnType<typeof createItemExtractor>, json: string) {
  extractor.tokenizer.write(encoder.encode(json));
  extractor.tokenizer.end();
}

describe('createItemExtractor', () => {
  it('parses items from valid { data: [...] } payload', () => {
    const ext = createItemExtractor('test-key');
    const payload = JSON.stringify({
      data: [
        { type: 'session', data: { title: 'Hello' } },
        { type: 'message', data: { id: 'msg_1' } },
      ],
    });

    feedAll(ext, payload);

    expect(ext.pending).toHaveLength(2);
    expect(ext.pending[0]).toEqual({ type: 'session', data: { title: 'Hello' } });
    expect(ext.pending[1]).toEqual({ type: 'message', data: { id: 'msg_1' } });
    expect(ext.getParseError()).toBeNull();
  });

  it('handles empty data array', () => {
    const ext = createItemExtractor('test-key');
    feedAll(ext, JSON.stringify({ data: [] }));

    expect(ext.pending).toHaveLength(0);
    expect(ext.getParseError()).toBeNull();
  });

  it('skips oversized items (byte budget)', () => {
    // MAX_SINGLE_ITEM_BYTES is mocked to 500
    const ext = createItemExtractor('test-key');

    // Create an item that exceeds 500 bytes
    const bigValue = 'x'.repeat(600);
    const payload = JSON.stringify({
      data: [
        { type: 'big', data: { content: bigValue } },
        { type: 'small', data: { ok: true } },
      ],
    });

    feedAll(ext, payload);

    // The oversized item should be skipped, but the small one should parse
    expect(ext.pending).toHaveLength(1);
    expect(ext.pending[0]).toEqual({ type: 'small', data: { ok: true } });
  });

  it('clears skippingItem when oversize item ends on closing brace', () => {
    // MAX_SINGLE_ITEM_BYTES is mocked to 500
    const ext = createItemExtractor('test-key');

    // A flat object (no nested braces) that exceeds budget — the closing }
    // is the token that triggers the budget check AND ends the item at depth=2
    const bigValue = 'y'.repeat(600);
    const payload = JSON.stringify({
      data: [{ big: bigValue }, { type: 'after', ok: true }],
    });

    feedAll(ext, payload);

    // The first item is oversized and skipped; the second should parse fine
    expect(ext.pending).toHaveLength(1);
    expect(ext.pending[0]).toEqual({ type: 'after', ok: true });
  });

  it('sets parseError on malformed JSON', () => {
    const ext = createItemExtractor('test-key');

    // Feed invalid JSON
    ext.tokenizer.write(encoder.encode('{ data: ['));
    ext.tokenizer.end();

    expect(ext.getParseError()).toBeInstanceOf(Error);
  });

  it('ignores non-data top-level keys', () => {
    const ext = createItemExtractor('test-key');
    const payload = JSON.stringify({
      meta: { version: 1 },
      other: [{ type: 'ignored' }],
      data: [{ type: 'included', data: {} }],
    });

    feedAll(ext, payload);

    expect(ext.pending).toHaveLength(1);
    expect(ext.pending[0]).toEqual({ type: 'included', data: {} });
  });
});

describe('queue', () => {
  it('delays failed queue message retries to avoid immediately hammering hot DOs', async () => {
    const limit = vi.fn(async () => [{ session_id: 'ses_retry' }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => ({ from })) } as never);
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://unused' },
      SESSION_INGEST_R2: { get: vi.fn(async () => null) },
    } as never;
    const ack = vi.fn();
    const retry = vi.fn();

    await queue(
      {
        messages: [
          {
            body: {
              r2Key: 'ingest/retry-missing',
              kiloUserId: 'usr_retry',
              sessionId: 'ses_retry',
              ingestVersion: 1,
              ingestedAt: 1,
            },
            ack,
            retry,
          },
        ],
      } as never,
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext
    );

    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('passes full parsed oversized message data and its R2 reference into ingest', async () => {
    const ingest = vi.fn(async () => ({ changes: [] }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ ingest } as never);
    const limit = vi.fn(async () => [{ session_id: 'ses_compacted' }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    vi.mocked(getWorkerDb).mockReturnValue({ select: vi.fn(() => ({ from })) } as never);
    const data = {
      id: 'msg_compacted',
      sessionID: 'ses_compacted',
      time: { created: 123 },
      content: 'x'.repeat(150),
    };
    const body = JSON.stringify({ data: [{ type: 'message', data }] });
    const put = vi.fn(async () => undefined);
    const deleteObject = vi.fn(async () => undefined);
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://unused' },
      SESSION_INGEST_R2: {
        get: vi.fn(async () => new Response(body)),
        put,
        delete: deleteObject,
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
              r2Key: 'staging/items',
              kiloUserId: 'usr_compacted',
              sessionId: 'ses_compacted',
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

    const expectedR2Key = 'items/usr_compacted/ses_compacted/message/msg_compacted/456';
    expect(put).toHaveBeenCalledWith(expectedR2Key, JSON.stringify(data));
    expect(ingest).toHaveBeenCalledWith(
      [{ type: 'message', data }],
      'usr_compacted',
      'ses_compacted',
      1,
      456,
      { 'message/msg_compacted': expectedR2Key }
    );
    expect(deleteObject).toHaveBeenCalledWith('staging/items');
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});

describe('computeSessionMetadataUpdates', () => {
  const fixedNow = () => '2026-05-05T00:00:00.000Z';

  it('normalizes gitUrl to the canonical form before persisting', () => {
    const updates = computeSessionMetadataUpdates(
      new Map([['gitUrl', 'https://GitHub.com/ACME/Widgets.git']]),
      fixedNow
    );
    expect(updates.git_url).toBe('https://github.com/acme/widgets');
  });

  it('collapses scp-style and ssh:// URLs to the same normalized form as https', () => {
    const fromScp = computeSessionMetadataUpdates(
      new Map([['gitUrl', 'git@github.com:acme/widgets.git']]),
      fixedNow
    );
    const fromSsh = computeSessionMetadataUpdates(
      new Map([['gitUrl', 'ssh://git@github.com/acme/widgets.git']]),
      fixedNow
    );
    const fromHttps = computeSessionMetadataUpdates(
      new Map([['gitUrl', 'https://github.com/acme/widgets']]),
      fixedNow
    );
    expect(fromScp.git_url).toBe('https://github.com/acme/widgets');
    expect(fromSsh.git_url).toBe(fromScp.git_url);
    expect(fromHttps.git_url).toBe(fromScp.git_url);
  });

  it('writes null git_url when the ingest cleared the field', () => {
    const updates = computeSessionMetadataUpdates(new Map([['gitUrl', null]]), fixedNow);
    expect(updates.git_url).toBeNull();
  });

  it('does not set git_url when the change does not include it', () => {
    const updates = computeSessionMetadataUpdates(
      new Map([
        ['gitBranch', 'feature/x'],
        ['title', 'hello'],
      ]),
      fixedNow
    );
    expect('git_url' in updates).toBe(false);
    expect(updates.git_branch).toBe('feature/x');
    expect(updates.title).toBe('hello');
  });

  it('stamps status_updated_at when status changes', () => {
    const updates = computeSessionMetadataUpdates(new Map([['status', 'running']]), fixedNow);
    expect(updates.status).toBe('running');
    expect(updates.status_updated_at).toBe('2026-05-05T00:00:00.000Z');
  });

  it('ignores a null "platform" change (creation value stays sticky)', () => {
    const updates = computeSessionMetadataUpdates(new Map([['platform', null]]), fixedNow);
    expect('created_on_platform' in updates).toBe(false);
  });
});

describe('queue status notifications', () => {
  it('emits a status update using the locked pre-update status instead of the intake snapshot', async () => {
    vi.mocked(notifyUserSessionEvent).mockClear();
    const persistedSession = {
      session_id: 'ses_12345678901234567890123456',
      created_at: '2026-05-05T00:00:00.000Z',
      updated_at: '2026-05-05T00:00:01.000Z',
      title: null,
      created_on_platform: null,
      organization_id: null,
      git_url: null,
      git_branch: null,
      parent_session_id: null,
      status: 'idle',
      status_updated_at: '2026-05-05T00:00:01.000Z',
    };
    const selectResults: unknown[][] = [
      [{ session_id: persistedSession.session_id, status: 'idle' }],
      [{ status: 'busy' }],
      [persistedSession],
    ];
    const selectResult = vi.fn(async () => selectResults.shift() ?? []);
    const select = {
      from: vi.fn(() => select),
      where: vi.fn(() => select),
      limit: vi.fn(() => select),
      for: vi.fn(() => select),
      then: vi.fn((resolve: (value: unknown) => unknown) => resolve(selectResult())),
    };
    const update = {
      set: vi.fn(() => update),
      where: vi.fn(() => update),
      then: vi.fn((resolve: (value: undefined) => unknown) => resolve(undefined)),
    };
    const dbRef: Record<string, unknown> = {};
    const db = {
      select: vi.fn(() => select),
      update: vi.fn(() => update),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbRef)),
    } as unknown as ReturnType<typeof getWorkerDb>;
    Object.assign(dbRef, db);
    vi.mocked(getWorkerDb).mockReturnValue(db);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      ingest: vi.fn(async () => ({ changes: [{ name: 'status', value: 'idle' }] })),
    } as never);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ data: [{ type: 'session_status', data: { status: 'idle' } }] })
          )
        );
        controller.close();
      },
    });
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://test' },
      SESSION_INGEST_R2: {
        get: vi.fn(async () => ({ body })),
        delete: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    } as never;
    const ack = vi.fn();
    const batch = {
      messages: [
        {
          body: {
            r2Key: 'ingest/status-change',
            kiloUserId: 'usr_test',
            sessionId: persistedSession.session_id,
            ingestVersion: 1,
            ingestedAt: 1,
          },
          ack,
          retry: vi.fn(),
        },
      ],
    } as never;
    const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;

    await queue(batch, env, ctx);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      env,
      'usr_test',
      expect.objectContaining({
        type: 'session.status.updated',
        data: expect.objectContaining({ previousStatus: 'busy', status: 'idle' }),
      }),
      ctx
    );
  });
});
