import { describe, expect, it, vi } from 'vitest';
import type { SessionLiveSummary } from '@kilocode/session-ingest-contracts';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));

import {
  createLivePersistQueue,
  livePersistBackoffMs,
  mergeLiveSessionColumns,
} from './live-session-columns';

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeQueue(now: () => number = Date.now) {
  const writes: Array<{ request: number[]; result: Deferred }> = [];
  const written: number[][] = [];
  const failed: number[][] = [];
  const queue = createLivePersistQueue<number[]>({
    merge: (earlier, later) => [...earlier, ...later],
    write: request => {
      const result = deferred();
      writes.push({ request, result });
      return result.promise;
    },
    onWritten: request => written.push(request),
    onFailed: request => failed.push(request),
    now,
  });
  return { queue, writes, written, failed };
}

describe('createLivePersistQueue', () => {
  it('merges requests that arrive during a write into one next write', async () => {
    const { queue, writes, written } = makeQueue();
    const run = queue.schedule([1]);
    expect(queue.schedule([2])).toBeUndefined();
    expect(queue.schedule([3])).toBeUndefined();
    expect(writes.map(write => write.request)).toEqual([[1]]);

    writes[0].result.resolve();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].request).toEqual([2, 3]);
    writes[1].result.resolve();
    await run;
    expect(written).toEqual([[1], [2, 3]]);
  });

  it('keeps a failed request pending and writes nothing until the backoff ends', async () => {
    let now = 1_000;
    const { queue, writes, written, failed } = makeQueue(() => now);
    const run = queue.schedule([1]);
    writes[0].result.reject(new Error('lock timeout'));
    await run;
    expect(failed).toEqual([[1]]);

    now += livePersistBackoffMs(1) - 1;
    expect(queue.schedule([2])).toBeUndefined();
    expect(writes).toHaveLength(1);

    now += 1;
    const retry = queue.schedule([3]);
    expect(writes[1].request).toEqual([1, 2, 3]);
    writes[1].result.resolve();
    await retry;
    expect(written).toEqual([[1, 2, 3]]);
  });

  it('flushes after the write in flight and during a backoff, and rejects on failure', async () => {
    const { queue, writes, written } = makeQueue(() => 1_000);
    const run = queue.schedule([1]);
    writes[0].result.reject(new Error('pool full'));
    await run;
    expect(queue.schedule([2])).toBeUndefined();

    const failedFlush = queue.flush([3]);
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].request).toEqual([1, 2, 3]);
    writes[1].result.reject(new Error('pool full'));
    await expect(failedFlush).rejects.toThrow('pool full');

    const flush = queue.flush([4]);
    await vi.waitFor(() => expect(writes).toHaveLength(3));
    expect(writes[2].request).toEqual([1, 2, 3, 4]);
    writes[2].result.resolve();
    await flush;
    expect(written).toEqual([[1, 2, 3, 4]]);
  });

  it('lets a flush wait for the write in flight, which carries the flushed values', async () => {
    const { queue, writes, written } = makeQueue();
    const run = queue.schedule([1]);
    const flush = queue.flush([2]);
    writes[0].result.resolve();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    writes[1].result.resolve();
    await Promise.all([run, flush]);
    expect(written).toEqual([[1], [2]]);
    expect(writes).toHaveLength(2);
  });

  it('caps the backoff', () => {
    expect(livePersistBackoffMs(1)).toBe(15_000);
    expect(livePersistBackoffMs(2)).toBe(30_000);
    expect(livePersistBackoffMs(10)).toBe(120_000);
  });
});

describe('mergeLiveSessionColumns', () => {
  const summary = (title: string) => ({ title }) as unknown as SessionLiveSummary;

  it('keeps the value each CASE guard would leave', () => {
    const merged = mergeLiveSessionColumns(
      {
        costMicrodollars: 300,
        lastActivityAtIso: '2026-01-01T00:00:02.000Z',
        liveSummary: { summary: summary('newer'), atIso: '2026-01-01T00:00:02.000Z' },
        briefingExcerpt: {
          excerpt: { messageId: 'b', completedAt: '2026-01-01T00:00:01.000Z', text: 'B' },
          receivedAtIso: '2026-01-01T00:00:01.000Z',
        },
      },
      {
        costMicrodollars: 200,
        lastActivityAtIso: '2026-01-01T00:00:01.000Z',
        liveSummary: { summary: summary('older'), atIso: '2026-01-01T00:00:01.000Z' },
        briefingExcerpt: {
          excerpt: { messageId: 'a', completedAt: '2026-01-01T00:00:01.000Z', text: 'A' },
          receivedAtIso: '2026-01-01T00:00:03.000Z',
        },
      }
    );
    expect(merged.costMicrodollars).toBe(300);
    expect(merged.lastActivityAtIso).toBe('2026-01-01T00:00:02.000Z');
    expect(merged.liveSummary?.summary).toEqual({ title: 'newer' });
    expect(merged.briefingExcerpt?.excerpt.messageId).toBe('b');
  });

  it('keeps columns that only one write carries', () => {
    expect(mergeLiveSessionColumns({ costMicrodollars: 5 }, { lastActivityAtIso: 'x' })).toEqual({
      costMicrodollars: 5,
      lastActivityAtIso: 'x',
    });
  });
});
