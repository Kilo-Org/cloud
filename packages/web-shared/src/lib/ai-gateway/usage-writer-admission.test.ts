import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
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
    gate.tryAcquire(index % 2 ? 'queue' : 'queue_vercel', 'usage-id')
  );
  expect(held.every(slot => slot.admitted)).toBe(true);
  expect(gate.tryAcquire('queue', 'usage-id')).toEqual({ admitted: false, reason: 'queue_limit' });
  const first = held[0];
  if (!first.admitted) throw new Error('expected admitted slot');
  first.release();
  first.release();
  const replacement = gate.tryAcquire('queue_vercel', 'usage-id');
  expect(replacement.admitted).toBe(true);
  // Double release must not create an extra slot.
  expect(gate.tryAcquire('queue', 'usage-id')).toEqual({ admitted: false, reason: 'queue_limit' });
  for (const slot of [...held, replacement]) if (slot.admitted) slot.release();
  expect(gate.tryAcquire('queue', 'usage-id').admitted).toBe(true);
});

it.each([
  [1, 1],
  [2, 1],
  [5, 3],
  [10, 8],
])('derives %s-connection pool admission bound %s without changing the pool', (max, limit) => {
  const currentPool = pool(max);
  const gate = createQueueWriterAdmission(currentPool);
  for (let index = 0; index < limit; index++)
    expect(gate.tryAcquire('queue', 'usage-id').admitted).toBe(true);
  expect(gate.tryAcquire('queue', 'usage-id')).toEqual({ admitted: false, reason: 'queue_limit' });
  expect(currentPool.options.max).toBe(max);
});

it('distinguishes idle capacity, busy headroom and queued pool demand without acquiring DB clients', () => {
  const currentPool = { ...pool(), totalCount: 10, idleCount: 3 };
  const gate = createQueueWriterAdmission(currentPool);
  const slot = gate.tryAcquire('queue', 'usage-id');
  expect(slot.admitted).toBe(true);
  if (slot.admitted) slot.release();
  currentPool.idleCount = 2;
  expect(gate.tryAcquire('queue', 'usage-id')).toEqual({ admitted: false, reason: 'pool_busy' });
  currentPool.waitingCount = 1;
  expect(gate.tryAcquire('queue', 'usage-id')).toEqual({ admitted: false, reason: 'pool_waiting' });
  currentPool.waitingCount = 0;
  currentPool.idleCount = 10;
  expect(gate.tryAcquire('queue', 'usage-id').admitted).toBe(true);
});

it('samples admission and always reports rejection using only bounded fields and pool gauges', () => {
  const currentPool = pool();
  const gate = createQueueWriterAdmission(currentPool);
  gate.tryAcquire('queue', 'usage-id');
  expect(console.info).not.toHaveBeenCalled();
  jest.mocked(Math.random).mockReturnValue(0);
  gate.tryAcquire('queue_vercel', 'usage-id');
  expect(JSON.parse(jest.mocked(console.info).mock.calls[0][0])).toEqual({
    event: 'usage_writer_admission',
    writer_caller: 'queue_vercel',
    writer_class: 'queue',
    outcome: 'admitted',
    reason: null,
    active: 2,
    active_direct: 0,
    limit: 8,
    direct_limit: 5,
    pool_max: 10,
    pool: { total: 0, idle: 0, waiting: 0 },
    sample_rate: 0.01,
  });
  jest.mocked(Math.random).mockReturnValue(1);
  currentPool.waitingCount = 1;
  gate.tryAcquire('queue', 'usage-id');
  expect(JSON.parse(jest.mocked(console.warn).mock.calls[0][0])).toEqual({
    event: 'usage_writer_admission',
    writer_caller: 'queue',
    writer_class: 'queue',
    outcome: 'rejected',
    reason: 'pool_waiting',
    active: 2,
    active_direct: 0,
    limit: 8,
    direct_limit: 5,
    pool_max: 10,
    pool: { total: 0, idle: 0, waiting: 1 },
    sample_rate: 1,
    usage_id: 'usage-id',
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
    const first = gate.tryAcquire('queue', 'usage-id');
    expect(first.admitted).toBe(true);
    expect(gate.tryAcquire('queue_vercel', 'usage-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    if (first.admitted) first.release();
    expect(gate.tryAcquire('queue', 'usage-id').admitted).toBe(true);
  }
);

it.each(['queue_limit', 'pool_waiting', 'pool_busy'] as const)(
  'logs the usage id for %s rejection',
  reason => {
    const currentPool = pool(3);
    const gate = createQueueWriterAdmission(currentPool);
    if (reason === 'queue_limit') gate.tryAcquire('queue', 'held-id');
    if (reason === 'pool_waiting') currentPool.waitingCount = 1;
    if (reason === 'pool_busy') currentPool.totalCount = 1;
    expect(gate.tryAcquire('queue', 'rejected-id')).toEqual({ admitted: false, reason });
    expect(JSON.parse(jest.mocked(console.warn).mock.calls[0][0])).toMatchObject({
      reason,
      usage_id: 'rejected-id',
      sample_rate: 1,
    });
  }
);

function admitted(slot: ReturnType<ReturnType<typeof createQueueWriterAdmission>['tryAcquire']>) {
  if (!slot.admitted) throw new Error(`expected admitted slot, got ${slot.reason}`);
  return slot;
}

describe('ingress_direct class ceiling', () => {
  it('holds at most five of the eight shared slots so queue callers keep three', () => {
    const gate = createQueueWriterAdmission(pool());
    const direct = Array.from({ length: 5 }, () =>
      admitted(gate.tryAcquire('ingress_direct', 'usage-id'))
    );
    expect(gate.tryAcquire('ingress_direct', 'usage-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    const queue = Array.from({ length: 3 }, (_, index) =>
      admitted(gate.tryAcquire(index % 2 ? 'queue_vercel' : 'queue', 'usage-id'))
    );
    expect(gate.tryAcquire('queue', 'usage-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(gate.tryAcquire('ingress_direct', 'usage-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    for (const slot of [...direct, ...queue]) slot.release();
  });

  it('admits a queue request while a sixth direct request is rejected below the shared limit', () => {
    const gate = createQueueWriterAdmission(pool());
    for (let index = 0; index < 5; index++) admitted(gate.tryAcquire('ingress_direct', 'usage-id'));
    expect(gate.tryAcquire('ingress_direct', 'rejected-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(JSON.parse(jest.mocked(console.warn).mock.calls[0][0])).toEqual({
      event: 'usage_writer_admission',
      writer_caller: 'ingress_direct',
      writer_class: 'direct',
      outcome: 'rejected',
      reason: 'queue_limit',
      active: 5,
      active_direct: 5,
      limit: 8,
      direct_limit: 5,
      pool_max: 10,
      pool: { total: 0, idle: 0, waiting: 0 },
      sample_rate: 1,
      usage_id: 'rejected-id',
    });
    expect(gate.tryAcquire('queue', 'usage-id').admitted).toBe(true);
  });

  it('lets queue callers take all eight slots and then rejects direct as well', () => {
    const gate = createQueueWriterAdmission(pool());
    for (let index = 0; index < 8; index++) admitted(gate.tryAcquire('queue', 'usage-id'));
    expect(gate.tryAcquire('ingress_direct', 'usage-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
  });

  it('releases the class that acquired the slot, once', () => {
    const gate = createQueueWriterAdmission(pool());
    const direct = Array.from({ length: 5 }, () =>
      admitted(gate.tryAcquire('ingress_direct', 'usage-id'))
    );
    const queue = admitted(gate.tryAcquire('queue', 'usage-id'));
    queue.release();
    queue.release();
    expect(gate.tryAcquire('ingress_direct', 'usage-id').admitted).toBe(false);
    direct[0].release();
    direct[0].release();
    const replacement = admitted(gate.tryAcquire('ingress_direct', 'usage-id'));
    expect(gate.tryAcquire('ingress_direct', 'usage-id').admitted).toBe(false);
    jest.mocked(Math.random).mockReturnValue(0);
    admitted(gate.tryAcquire('queue', 'usage-id'));
    expect(JSON.parse(jest.mocked(console.info).mock.calls.at(-1)?.[0])).toMatchObject({
      writer_class: 'queue',
      active: 6,
      active_direct: 5,
    });
    for (const slot of [...direct, replacement]) slot.release();
  });

  it.each([
    [1, 1, 1],
    [3, 1, 1],
    [5, 3, 1],
    [6, 4, 1],
    [10, 8, 5],
    [12, 10, 7],
  ])('gives a %s-connection pool shared limit %s and direct ceiling %s', (max, limit, ceiling) => {
    const gate = createQueueWriterAdmission(pool(max));
    for (let index = 0; index < ceiling; index++)
      admitted(gate.tryAcquire('ingress_direct', 'usage-id'));
    expect(gate.tryAcquire('ingress_direct', 'usage-id').admitted).toBe(false);
    for (let index = ceiling; index < limit; index++)
      admitted(gate.tryAcquire('queue', 'usage-id'));
    expect(gate.tryAcquire('queue', 'usage-id').admitted).toBe(false);
  });
});
