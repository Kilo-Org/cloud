import 'server-only';

import { pool } from '@kilocode/web-shared/lib/drizzle';

type WriterPool = {
  options: { max: number };
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
};

type QueueSource = 'queue' | 'queue_vercel';
type WriterClass = 'queue' | 'non_llm';
type RejectionReason = 'queue_limit' | 'pool_waiting' | 'pool_busy';
type Admission =
  | { admitted: false; reason: RejectionReason }
  | { admitted: true; release: () => void };
type PoolGauges = { total: number; idle: number; waiting: number };
type SlotWait = { slotWaitMs: number; waited: boolean };
type Waiter = {
  writerClass: WriterClass;
  settle: (reason: RejectionReason | null, gauges: PoolGauges) => void;
};

const IMMEDIATE: SlotWait = { slotWaitMs: 0, waited: false };

/** Per-runtime writer bound, not a reservation of connections or global DB capacity. */
export function createQueueWriterAdmission(writerPool: WriterPool) {
  const poolMax = writerPool.options.max;
  const limit = Math.max(1, poolMax - 2);
  // A ceiling inside `limit`, not a reservation: non-LLM usage writes may hold at most
  // this many shared slots, and LLM queue writes can still use all of `limit`.
  const nonLlmLimit = Math.max(1, Math.min(2, limit - 1));
  let active = 0;
  let activeNonLlm = 0;
  // Released slots pass directly to the oldest waiter, so `active` stays at `limit`
  // while anyone waits and new callers cannot overtake the queue.
  const waiters: Waiter[] = [];

  const readGauges = (): PoolGauges => ({
    total: writerPool.totalCount,
    idle: writerPool.idleCount,
    waiting: writerPool.waitingCount,
  });
  const poolReason = (gauges: PoolGauges): RejectionReason | null =>
    gauges.waiting > 0 ? 'pool_waiting' : gauges.total - gauges.idle >= limit ? 'pool_busy' : null;
  const classFull = (writerClass: WriterClass) =>
    writerClass === 'non_llm' && activeNonLlm >= nonLlmLimit;
  const nonLlmWaiting = () => waiters.filter(waiter => waiter.writerClass === 'non_llm').length;
  function take(writerClass: WriterClass) {
    if (writerClass === 'non_llm') activeNonLlm++;
  }

  function report(
    source: QueueSource,
    writerClass: WriterClass,
    usageId: string,
    reason: RejectionReason | null,
    gauges: PoolGauges,
    wait: SlotWait | null
  ) {
    try {
      const sampleRate = reason === null ? 0.01 : 1;
      if (sampleRate === 1 || Math.random() < sampleRate) {
        console[reason === null ? 'info' : 'warn'](
          JSON.stringify({
            event: 'usage_writer_admission',
            writer_caller: source,
            writer_class: writerClass,
            outcome: reason === null ? 'admitted' : 'rejected',
            reason,
            active,
            active_non_llm: activeNonLlm,
            limit,
            non_llm_limit: nonLlmLimit,
            pool_max: poolMax,
            pool: gauges,
            sample_rate: sampleRate,
            ...(wait ? { slot_wait_ms: wait.slotWaitMs } : {}),
            ...(wait?.waited && reason !== null ? { waited: true } : {}),
            ...(reason !== null ? { usage_id: usageId } : {}),
          })
        );
      }
    } catch (error) {
      console.error('[usage-writer-admission] admission diagnostic failed; the decision stands', {
        error_name: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  function heldSlot(writerClass: WriterClass): Admission {
    let released = false;
    return {
      admitted: true,
      release() {
        if (released) return;
        released = true;
        if (writerClass === 'non_llm') activeNonLlm--;
        passOrFreeSlot();
      },
    };
  }

  function passOrFreeSlot() {
    for (let waiter = waiters.shift(); waiter; waiter = waiters.shift()) {
      const gauges = readGauges();
      const reason = classFull(waiter.writerClass) ? 'queue_limit' : poolReason(gauges);
      if (reason === null) take(waiter.writerClass);
      waiter.settle(reason, gauges);
      if (reason === null) return;
    }
    active--;
  }

  function decideNow(
    source: QueueSource,
    writerClass: WriterClass,
    usageId: string,
    wait: SlotWait | null
  ): Admission {
    const gauges = readGauges();
    const reason = active >= limit || classFull(writerClass) ? 'queue_limit' : poolReason(gauges);
    // Reserve synchronously: concurrent requests can all see an empty pool queue.
    if (reason === null) {
      active++;
      take(writerClass);
    }
    report(source, writerClass, usageId, reason, gauges, wait);
    return reason === null ? heldSlot(writerClass) : { admitted: false, reason };
  }

  return {
    tryAcquire(source: QueueSource, usageId: string): Admission {
      return decideNow(source, 'queue', usageId, null);
    },

    /**
     * Waits up to `maxWaitMs` in a FIFO of at most `limit` callers when this
     * runtime's own slots are full; waiting pool clients still reject immediately.
     * `pool_busy` is deferred to grant time at the limit: this runtime's own active
     * writers can occupy the pool, so checked-out connections are not independent
     * evidence of additional pressure there. Both pool reasons are rechecked at grant.
     * A `non_llm` caller also counts against its class ceiling, and its active plus
     * queued callers never exceed that ceiling, so it cannot crowd LLM writes out of
     * the FIFO either.
     */
    acquire(
      source: QueueSource,
      usageId: string,
      {
        maxWaitMs,
        signal,
        writerClass = 'queue',
      }: { maxWaitMs: number; signal?: AbortSignal; writerClass?: WriterClass }
    ): Promise<Admission> {
      if (active >= limit) {
        const gauges = readGauges();
        if (gauges.waiting > 0) {
          report(source, writerClass, usageId, 'pool_waiting', gauges, IMMEDIATE);
          return Promise.resolve({ admitted: false, reason: 'pool_waiting' });
        }
      }
      const classRoom = writerClass === 'queue' || activeNonLlm + nonLlmWaiting() < nonLlmLimit;
      const canWait =
        active >= limit && maxWaitMs > 0 && waiters.length < limit && classRoom && !signal?.aborted;
      if (!canWait) return Promise.resolve(decideNow(source, writerClass, usageId, IMMEDIATE));

      return new Promise(resolve => {
        const enqueuedAt = Date.now();
        const settle = (reason: RejectionReason | null, gauges: PoolGauges) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', leave);
          report(source, writerClass, usageId, reason, gauges, {
            slotWaitMs: Date.now() - enqueuedAt,
            waited: true,
          });
          resolve(reason === null ? heldSlot(writerClass) : { admitted: false, reason });
        };
        const waiter: Waiter = { writerClass, settle };
        function leave() {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          settle('queue_limit', readGauges());
        }
        const timer = setTimeout(leave, maxWaitMs);
        signal?.addEventListener('abort', leave, { once: true });
        waiters.push(waiter);
      });
    },
  };
}

export const queueWriterAdmission = createQueueWriterAdmission(pool);
