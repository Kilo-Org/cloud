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
  jest.spyOn(console, 'error').mockImplementation(() => {});
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
    active_non_llm: 0,
    active_direct: 0,
    limit: 8,
    non_llm_limit: 2,
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
    active_non_llm: 0,
    active_direct: 0,
    limit: 8,
    non_llm_limit: 2,
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
    expect(console.error).toHaveBeenCalledWith(
      '[usage-writer-admission] admission diagnostic failed; the decision stands',
      { error_name: 'Error' }
    );
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain('usage-id');
  }
);

describe('acquire', () => {
  type Gate = ReturnType<typeof createQueueWriterAdmission>;
  type Admission = ReturnType<Gate['tryAcquire']>;

  const logs = (level: 'info' | 'warn') =>
    jest.mocked(console[level]).mock.calls.map(([line]) => JSON.parse(String(line)));
  const hold = (gate: Gate, count: number) =>
    Array.from({ length: count }, () => gate.tryAcquire('queue', 'held-id'));
  function release(admission: Admission) {
    if (!admission.admitted) throw new Error('expected admitted slot');
    admission.release();
  }
  function expectNoActiveSlots(gate: Gate, limit: number) {
    const slots = hold(gate, limit);
    expect(slots.every(slot => slot.admitted)).toBe(true);
    expect(gate.tryAcquire('queue', 'probe-id')).toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    slots.forEach(release);
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits for a released slot within maxWaitMs and reports the wait', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    const [held] = hold(gate, 1);
    jest.mocked(Math.random).mockReturnValue(0);
    const pending = gate.acquire('queue_vercel', 'waiting-id', { maxWaitMs: 250 });
    jest.advanceTimersByTime(100);
    release(held);
    const admission = await pending;
    expect(admission.admitted).toBe(true);
    expect(logs('info').at(-1)).toEqual({
      event: 'usage_writer_admission',
      writer_caller: 'queue_vercel',
      writer_class: 'queue',
      outcome: 'admitted',
      reason: null,
      active: 1,
      active_non_llm: 0,
      active_direct: 0,
      limit: 1,
      non_llm_limit: 1,
      direct_limit: 1,
      pool_max: 3,
      pool: { total: 0, idle: 0, waiting: 0 },
      sample_rate: 0.01,
      slot_wait_ms: 100,
    });
    release(admission);
    jest.advanceTimersByTime(1000);
    expect(console.warn).not.toHaveBeenCalled();
    expectNoActiveSlots(gate, 1);
  });

  it('reports slot_wait_ms 0 for immediate decisions', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    jest.mocked(Math.random).mockReturnValue(0);
    const admission = await gate.acquire('queue', 'usage-id', { maxWaitMs: 250 });
    expect(logs('info')[0]).toMatchObject({ outcome: 'admitted', slot_wait_ms: 0 });
    expect(logs('info')[0]).not.toHaveProperty('waited');
    release(admission);
    expectNoActiveSlots(gate, 1);
  });

  it('grants one waiter per release in FIFO order', async () => {
    const gate = createQueueWriterAdmission(pool(5));
    const held = hold(gate, 3);
    const granted: string[] = [];
    const waiting = ['first', 'second', 'third'].map(usageId =>
      gate.acquire('queue', usageId, { maxWaitMs: 250 }).then(admission => {
        granted.push(usageId);
        return admission;
      })
    );
    release(held[0]);
    await jest.advanceTimersByTimeAsync(0);
    expect(granted).toEqual(['first']);
    release(held[1]);
    await jest.advanceTimersByTimeAsync(0);
    expect(granted).toEqual(['first', 'second']);
    release(held[2]);
    const admissions = await Promise.all(waiting);
    expect(granted).toEqual(['first', 'second', 'third']);
    expect(admissions.every(admission => admission.admitted)).toBe(true);
    admissions.forEach(release);
    expectNoActiveSlots(gate, 3);
  });

  it('rejects a caller beyond the FIFO cap immediately', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    const [held] = hold(gate, 1);
    const queued = gate.acquire('queue', 'queued-id', { maxWaitMs: 250 });
    await expect(gate.acquire('queue', 'overflow-id', { maxWaitMs: 250 })).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(logs('warn').at(-1)).toMatchObject({
      reason: 'queue_limit',
      usage_id: 'overflow-id',
      slot_wait_ms: 0,
    });
    expect(logs('warn').at(-1)).not.toHaveProperty('waited');
    release(held);
    const admission = await queued;
    expect(admission.admitted).toBe(true);
    release(admission);
    expectNoActiveSlots(gate, 1);
  });

  it('times out a waiter with queue_limit and a later release does not over-grant', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    const [held] = hold(gate, 1);
    const pending = gate.acquire('queue', 'late-id', { maxWaitMs: 250 });
    jest.advanceTimersByTime(250);
    await expect(pending).resolves.toEqual({ admitted: false, reason: 'queue_limit' });
    expect(logs('warn').at(-1)).toMatchObject({
      outcome: 'rejected',
      reason: 'queue_limit',
      usage_id: 'late-id',
      slot_wait_ms: 250,
      waited: true,
      active: 1,
    });
    release(held);
    release(held);
    expectNoActiveSlots(gate, 1);
  });

  it('lets a grant just before the deadline win without a later timeout rejection', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    const [held] = hold(gate, 1);
    const pending = gate.acquire('queue', 'racing-id', { maxWaitMs: 250 });
    jest.advanceTimersByTime(249);
    release(held);
    jest.advanceTimersByTime(1);
    const admission = await pending;
    expect(admission.admitted).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
    release(admission);
    release(admission);
    expectNoActiveSlots(gate, 1);
  });

  it('does not wait when maxWaitMs is 0', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    const [held] = hold(gate, 1);
    await expect(gate.acquire('queue', 'usage-id', { maxWaitMs: 0 })).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    release(held);
    expectNoActiveSlots(gate, 1);
  });

  it.each([
    [{ waitingCount: 1 }, 'pool_waiting'],
    [{ totalCount: 10, idleCount: 2 }, 'pool_busy'],
  ] as const)('keeps %o an immediate %s rejection', async (gauges, reason) => {
    const currentPool = { ...pool(), ...gauges };
    const gate = createQueueWriterAdmission(currentPool);
    await expect(gate.acquire('queue', 'usage-id', { maxWaitMs: 250 })).resolves.toEqual({
      admitted: false,
      reason,
    });
    expect(logs('warn')[0]).toMatchObject({ reason, slot_wait_ms: 0, usage_id: 'usage-id' });
    expect(logs('warn')[0]).not.toHaveProperty('waited');
    Object.assign(currentPool, { totalCount: 0, idleCount: 0, waitingCount: 0 });
    expectNoActiveSlots(gate, 8);
  });

  it('rejects pool_waiting immediately at the full counter without queuing the caller', async () => {
    const currentPool = pool(3);
    const gate = createQueueWriterAdmission(currentPool);
    const [held] = hold(gate, 1);
    currentPool.waitingCount = 1;
    await expect(gate.acquire('queue', 'pressured-id', { maxWaitMs: 250 })).resolves.toEqual({
      admitted: false,
      reason: 'pool_waiting',
    });
    expect(logs('warn')).toEqual([
      expect.objectContaining({
        reason: 'pool_waiting',
        usage_id: 'pressured-id',
        active: 1,
        pool: { total: 0, idle: 0, waiting: 1 },
        slot_wait_ms: 0,
      }),
    ]);
    expect(logs('warn')[0]).not.toHaveProperty('waited');
    currentPool.waitingCount = 0;
    const queued = gate.acquire('queue', 'queued-id', { maxWaitMs: 250 });
    release(held);
    const admission = await queued;
    expect(admission.admitted).toBe(true);
    release(admission);
    jest.advanceTimersByTime(1000);
    expect(logs('warn')).toHaveLength(1);
    expectNoActiveSlots(gate, 1);
  });

  it('defers pool_busy at the full counter to grant time', async () => {
    const currentPool = pool(5);
    const gate = createQueueWriterAdmission(currentPool);
    const held = hold(gate, 3);
    Object.assign(currentPool, { totalCount: 5, idleCount: 2 });
    const queued = gate.acquire('queue', 'queued-id', { maxWaitMs: 250 });
    await jest.advanceTimersByTimeAsync(0);
    expect(console.warn).not.toHaveBeenCalled();
    currentPool.idleCount = 3;
    release(held[0]);
    const admission = await queued;
    expect(admission.admitted).toBe(true);
    [admission, held[1], held[2]].forEach(release);
    Object.assign(currentPool, { totalCount: 0, idleCount: 0 });
    expectNoActiveSlots(gate, 3);
  });

  it.each([
    [{ waitingCount: 1 }, 'pool_waiting'],
    [{ totalCount: 5, idleCount: 2 }, 'pool_busy'],
  ] as const)(
    'rechecks a woken waiter against %o and frees the slot after %s rejections',
    async (gauges, reason) => {
      const currentPool = pool(5);
      const gate = createQueueWriterAdmission(currentPool);
      const held = hold(gate, 3);
      const waiting = ['first', 'second'].map(usageId =>
        gate.acquire('queue', usageId, { maxWaitMs: 250 })
      );
      Object.assign(currentPool, gauges);
      release(held[0]);
      await expect(Promise.all(waiting)).resolves.toEqual([
        { admitted: false, reason },
        { admitted: false, reason },
      ]);
      expect(logs('warn').map(line => [line.usage_id, line.reason, line.waited])).toEqual([
        ['first', reason, true],
        ['second', reason, true],
      ]);
      Object.assign(currentPool, { totalCount: 0, idleCount: 0, waitingCount: 0 });
      const freed = await gate.acquire('queue', 'next-id', { maxWaitMs: 250 });
      expect(freed.admitted).toBe(true);
      [freed, held[1], held[2]].forEach(release);
      expectNoActiveSlots(gate, 3);
    }
  );

  it('drops an aborted waiter from the queue without consuming a slot', async () => {
    const gate = createQueueWriterAdmission(pool(4));
    const held = hold(gate, 2);
    const controller = new AbortController();
    const aborted = gate.acquire('queue', 'aborted-id', {
      maxWaitMs: 250,
      signal: controller.signal,
    });
    const next = gate.acquire('queue', 'next-id', { maxWaitMs: 250 });
    controller.abort();
    await expect(aborted).resolves.toEqual({ admitted: false, reason: 'queue_limit' });
    expect(logs('warn').at(-1)).toMatchObject({ usage_id: 'aborted-id', waited: true });
    release(held[0]);
    const admission = await next;
    expect(admission.admitted).toBe(true);
    [admission, held[1]].forEach(release);
    jest.advanceTimersByTime(1000);
    expectNoActiveSlots(gate, 2);
  });

  it('does not queue a caller that has already aborted', async () => {
    const gate = createQueueWriterAdmission(pool(3));
    const [held] = hold(gate, 1);
    await expect(
      gate.acquire('queue', 'usage-id', { maxWaitMs: 250, signal: AbortSignal.abort() })
    ).resolves.toEqual({ admitted: false, reason: 'queue_limit' });
    release(held);
    expectNoActiveSlots(gate, 1);
  });
});

describe('non_llm writer class', () => {
  type Gate = ReturnType<typeof createQueueWriterAdmission>;
  const nonLlm = { maxWaitMs: 250, writerClass: 'non_llm' } as const;
  function admitted(slot: Awaited<ReturnType<Gate['acquire']>>) {
    if (!slot.admitted) throw new Error(`expected admitted slot, got ${slot.reason}`);
    return slot;
  }
  const logs = (level: 'info' | 'warn') =>
    jest.mocked(console[level]).mock.calls.map(([line]) => JSON.parse(String(line)));

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds at most two of the eight shared slots so LLM queue writes keep six', async () => {
    const gate = createQueueWriterAdmission(pool());
    const side = [
      admitted(await gate.acquire('queue', 'side-1', nonLlm)),
      admitted(await gate.acquire('queue', 'side-2', nonLlm)),
    ];
    await expect(gate.acquire('queue', 'side-3', nonLlm)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(logs('warn').at(-1)).toMatchObject({
      writer_caller: 'queue',
      writer_class: 'non_llm',
      reason: 'queue_limit',
      active: 2,
      active_non_llm: 2,
      non_llm_limit: 2,
      usage_id: 'side-3',
    });
    const llm = Array.from({ length: 6 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    expect(gate.tryAcquire('queue', 'llm')).toEqual({ admitted: false, reason: 'queue_limit' });
    for (const slot of [...side, ...llm]) slot.release();
  });

  it('lets LLM queue writes take all eight slots and then rejects non_llm as well', async () => {
    const gate = createQueueWriterAdmission(pool());
    for (let index = 0; index < 8; index++) admitted(gate.tryAcquire('queue', 'llm'));
    await expect(gate.acquire('queue', 'side', { ...nonLlm, maxWaitMs: 0 })).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
  });

  it('does not queue a non_llm waiter at its ceiling, leaving the FIFO to LLM writes', async () => {
    const gate = createQueueWriterAdmission(pool());
    const side = [
      admitted(await gate.acquire('queue', 'side-1', nonLlm)),
      admitted(await gate.acquire('queue', 'side-2', nonLlm)),
    ];
    const llm = Array.from({ length: 6 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    await expect(gate.acquire('queue', 'side-3', nonLlm)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    const waitingLlm = gate.acquire('queue', 'llm-waiter', { maxWaitMs: 250 });
    side[0].release();
    const granted = admitted(await waitingLlm);
    for (const slot of [granted, side[1], ...llm]) slot.release();
  });

  it('caps queued non_llm waiters so a grant never exceeds the class ceiling', async () => {
    const gate = createQueueWriterAdmission(pool());
    const side = admitted(await gate.acquire('queue', 'side-1', nonLlm));
    const llm = Array.from({ length: 7 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    const firstWaiter = gate.acquire('queue', 'side-2', nonLlm);
    await expect(gate.acquire('queue', 'side-3', nonLlm)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    llm[0].release();
    const granted = admitted(await firstWaiter);
    await expect(gate.acquire('queue', 'side-4', { ...nonLlm, maxWaitMs: 0 })).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    for (const slot of [side, granted, ...llm.slice(1)]) slot.release();
  });

  it('returns a released non_llm slot to the class and the shared pool once', async () => {
    const gate = createQueueWriterAdmission(pool());
    const first = admitted(await gate.acquire('queue', 'side-1', nonLlm));
    const second = admitted(await gate.acquire('queue', 'side-2', nonLlm));
    first.release();
    first.release();
    const replacement = admitted(await gate.acquire('queue', 'side-3', nonLlm));
    await expect(gate.acquire('queue', 'side-4', nonLlm)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    second.release();
    replacement.release();
    const llm = Array.from({ length: 8 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    for (const slot of llm) slot.release();
  });

  it('hands an LLM slot to a waiting non_llm write below its ceiling and counts it', async () => {
    const gate = createQueueWriterAdmission(pool());
    const llm = Array.from({ length: 8 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    jest.mocked(Math.random).mockReturnValue(0);
    const waiting = gate.acquire('queue', 'side-1', nonLlm);
    llm[0].release();
    const granted = admitted(await waiting);
    expect(logs('info').at(-1)).toMatchObject({
      writer_class: 'non_llm',
      outcome: 'admitted',
      active: 8,
      active_non_llm: 1,
    });
    for (const slot of [granted, ...llm.slice(1)]) slot.release();
  });

  it.each([
    [1, 1, 1],
    [3, 1, 1],
    [4, 2, 1],
    [5, 3, 2],
    [10, 8, 2],
    [20, 18, 2],
  ])(
    'gives a %s-connection pool shared limit %s and non_llm ceiling %s',
    async (max, limit, ceiling) => {
      const gate = createQueueWriterAdmission(pool(max));
      for (let index = 0; index < ceiling; index++)
        admitted(await gate.acquire('queue', 'side', { ...nonLlm, maxWaitMs: 0 }));
      await expect(
        gate.acquire('queue', 'side', { ...nonLlm, maxWaitMs: 0 })
      ).resolves.toMatchObject({ admitted: false });
      for (let index = ceiling; index < limit; index++) admitted(gate.tryAcquire('queue', 'llm'));
      expect(gate.tryAcquire('queue', 'llm').admitted).toBe(false);
    }
  );
});

describe('direct writer class', () => {
  type Gate = ReturnType<typeof createQueueWriterAdmission>;
  const direct = { maxWaitMs: 250, writerClass: 'direct' } as const;
  const nonLlm = { maxWaitMs: 0, writerClass: 'non_llm' } as const;
  function admitted(slot: Awaited<ReturnType<Gate['acquire']>>) {
    if (!slot.admitted) throw new Error(`expected admitted slot, got ${slot.reason}`);
    return slot;
  }
  const logs = (level: 'info' | 'warn') =>
    jest.mocked(console[level]).mock.calls.map(([line]) => JSON.parse(String(line)));
  const holdDirect = async (gate: Gate, count: number) => {
    const slots = [];
    for (let index = 0; index < count; index++)
      slots.push(admitted(await gate.acquire('ingress_direct', 'direct', direct)));
    return slots;
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds at most five of the eight shared slots so LLM queue writes keep three', async () => {
    const gate = createQueueWriterAdmission(pool());
    const held = await holdDirect(gate, 5);
    await expect(gate.acquire('ingress_direct', 'direct-6', direct)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(logs('warn').at(-1)).toMatchObject({
      writer_caller: 'ingress_direct',
      writer_class: 'direct',
      reason: 'queue_limit',
      active: 5,
      active_direct: 5,
      direct_limit: 5,
      slot_wait_ms: 0,
      usage_id: 'direct-6',
    });
    const llm = Array.from({ length: 3 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    expect(gate.tryAcquire('queue', 'llm')).toEqual({ admitted: false, reason: 'queue_limit' });
    for (const slot of [...held, ...llm]) slot.release();
  });

  it('composes with non_llm: 5 direct + 2 non_llm leave one LLM queue slot of the shared 8', async () => {
    const gate = createQueueWriterAdmission(pool());
    const held = await holdDirect(gate, 5);
    const side = [
      admitted(await gate.acquire('queue', 'side-1', nonLlm)),
      admitted(await gate.acquire('queue', 'side-2', nonLlm)),
    ];
    await expect(gate.acquire('queue', 'side-3', nonLlm)).resolves.toMatchObject({
      admitted: false,
    });
    await expect(gate.acquire('ingress_direct', 'direct-6', direct)).resolves.toMatchObject({
      admitted: false,
    });
    const llm = admitted(gate.tryAcquire('queue', 'llm'));
    expect(gate.tryAcquire('queue', 'llm')).toEqual({ admitted: false, reason: 'queue_limit' });
    for (const slot of [...held, ...side, llm]) slot.release();
    const all = Array.from({ length: 8 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    for (const slot of all) slot.release();
  });

  it('never waits, so it cannot take a FIFO place or overtake a waiting queue write', async () => {
    const gate = createQueueWriterAdmission(pool());
    const llm = Array.from({ length: 8 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    const waitingLlm = gate.acquire('queue', 'llm-waiter', { maxWaitMs: 250 });
    await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    llm[0].release();
    const granted = admitted(await waitingLlm);
    await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    for (const slot of [granted, ...llm.slice(1)]) slot.release();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('applies the pool checks to direct calls below the ceiling', async () => {
    const currentPool = pool();
    const gate = createQueueWriterAdmission(currentPool);
    currentPool.waitingCount = 1;
    await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toEqual({
      admitted: false,
      reason: 'pool_waiting',
    });
    currentPool.waitingCount = 0;
    currentPool.totalCount = 8;
    await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toEqual({
      admitted: false,
      reason: 'pool_busy',
    });
  });

  it('returns a released direct slot to its class and the shared limit once', async () => {
    const gate = createQueueWriterAdmission(pool());
    const held = await holdDirect(gate, 5);
    held[0].release();
    held[0].release();
    const replacement = admitted(await gate.acquire('ingress_direct', 'direct', direct));
    await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toMatchObject({
      admitted: false,
    });
    for (const slot of [...held.slice(1), replacement]) slot.release();
    const llm = Array.from({ length: 8 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    for (const slot of llm) slot.release();
  });

  it('hands a slot released by a direct write to a waiting queue write', async () => {
    const gate = createQueueWriterAdmission(pool());
    const held = await holdDirect(gate, 5);
    const llm = Array.from({ length: 3 }, () => admitted(gate.tryAcquire('queue', 'llm')));
    const waitingLlm = gate.acquire('queue', 'llm-waiter', { maxWaitMs: 250 });
    held[0].release();
    const granted = admitted(await waitingLlm);
    await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toEqual({
      admitted: false,
      reason: 'queue_limit',
    });
    expect(logs('warn').at(-1)).toMatchObject({ active: 8, active_direct: 4 });
    for (const slot of [...held.slice(1), ...llm, granted]) slot.release();
  });

  it.each([
    [1, 1, 1],
    [3, 1, 1],
    [5, 3, 1],
    [6, 4, 1],
    [10, 8, 5],
    [12, 10, 7],
  ])(
    'gives a %s-connection pool shared limit %s and direct ceiling %s',
    async (max, limit, ceiling) => {
      const gate = createQueueWriterAdmission(pool(max));
      for (let index = 0; index < ceiling; index++)
        admitted(await gate.acquire('ingress_direct', 'direct', direct));
      await expect(gate.acquire('ingress_direct', 'direct', direct)).resolves.toMatchObject({
        admitted: false,
      });
      for (let index = ceiling; index < limit; index++) admitted(gate.tryAcquire('queue', 'llm'));
      expect(gate.tryAcquire('queue', 'llm').admitted).toBe(false);
    }
  );
});

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
