import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { createQueueWriterAdmission } from './usage-writer-admission';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0, options: { max: 10 } },
}));

function pool(max = 10) {
  return { options: { max }, totalCount: 0, idleCount: 0, waitingCount: 0 };
}

beforeEach(() => {
  jest.spyOn(Math, 'random').mockReturnValue(1);
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

it('bounds simultaneous queue work even before any pool gauge changes, and reuses slots', () => {
  const gate = createQueueWriterAdmission(pool());
  const held = Array.from({ length: 8 }, (_, index) =>
    gate.tryAcquire(index % 2 ? 'queue' : 'queue_vercel')
  );
  expect(held.every(slot => slot.admitted)).toBe(true);
  expect(gate.tryAcquire('queue')).toEqual({ admitted: false, reason: 'queue_limit' });
  const first = held[0];
  if (!first.admitted) throw new Error('expected admitted slot');
  first.release();
  first.release();
  const replacement = gate.tryAcquire('queue_vercel');
  expect(replacement.admitted).toBe(true);
  // Double release must not create an extra slot.
  expect(gate.tryAcquire('queue')).toEqual({ admitted: false, reason: 'queue_limit' });
  for (const slot of [...held, replacement]) if (slot.admitted) slot.release();
  expect(gate.tryAcquire('queue').admitted).toBe(true);
});

it.each([
  [1, 1],
  [2, 1],
  [5, 3],
  [10, 8],
])('derives %s-connection pool admission bound %s without changing the pool', (max, limit) => {
  const currentPool = pool(max);
  const gate = createQueueWriterAdmission(currentPool);
  for (let index = 0; index < limit; index++) expect(gate.tryAcquire('queue').admitted).toBe(true);
  expect(gate.tryAcquire('queue')).toEqual({ admitted: false, reason: 'queue_limit' });
  expect(currentPool.options.max).toBe(max);
});

it('distinguishes idle capacity, busy headroom and queued pool demand without acquiring DB clients', () => {
  const currentPool = { ...pool(), totalCount: 10, idleCount: 3 };
  const gate = createQueueWriterAdmission(currentPool);
  const slot = gate.tryAcquire('queue');
  expect(slot.admitted).toBe(true);
  if (slot.admitted) slot.release();
  currentPool.idleCount = 2;
  expect(gate.tryAcquire('queue')).toEqual({ admitted: false, reason: 'pool_busy' });
  currentPool.waitingCount = 1;
  expect(gate.tryAcquire('queue')).toEqual({ admitted: false, reason: 'pool_waiting' });
  currentPool.waitingCount = 0;
  currentPool.idleCount = 10;
  expect(gate.tryAcquire('queue').admitted).toBe(true);
});

it('samples admission and always reports rejection using only bounded fields and pool gauges', () => {
  const currentPool = pool();
  const gate = createQueueWriterAdmission(currentPool);
  gate.tryAcquire('queue');
  expect(console.info).not.toHaveBeenCalled();
  jest.mocked(Math.random).mockReturnValue(0);
  gate.tryAcquire('queue_vercel');
  expect(JSON.parse(jest.mocked(console.info).mock.calls[0][0])).toEqual({
    event: 'usage_writer_admission',
    writer_caller: 'queue_vercel',
    outcome: 'admitted',
    reason: null,
    active: 2,
    limit: 8,
    pool_max: 10,
    pool: { total: 0, idle: 0, waiting: 0 },
    sample_rate: 0.01,
  });
  jest.mocked(Math.random).mockReturnValue(1);
  currentPool.waitingCount = 1;
  gate.tryAcquire('queue');
  expect(JSON.parse(jest.mocked(console.warn).mock.calls[0][0])).toEqual({
    event: 'usage_writer_admission',
    writer_caller: 'queue',
    outcome: 'rejected',
    reason: 'pool_waiting',
    active: 2,
    limit: 8,
    pool_max: 10,
    pool: { total: 0, idle: 0, waiting: 1 },
    sample_rate: 1,
  });
});

it.each(['random', 'info', 'warn'] as const)(
  'keeps admission/release working when %s throws',
  failure => {
    const currentPool = pool(3);
    const gate = createQueueWriterAdmission(currentPool);
    jest.mocked(Math.random).mockReturnValue(0);
    const fail = () => {
      throw new Error('synthetic diagnostic failure');
    };
    if (failure === 'random') jest.mocked(Math.random).mockImplementation(fail);
    else jest.mocked(console[failure]).mockImplementation(fail);
    const first = gate.tryAcquire('queue');
    expect(first.admitted).toBe(true);
    expect(gate.tryAcquire('queue_vercel')).toEqual({ admitted: false, reason: 'queue_limit' });
    if (first.admitted) first.release();
    expect(gate.tryAcquire('queue').admitted).toBe(true);
  }
);
