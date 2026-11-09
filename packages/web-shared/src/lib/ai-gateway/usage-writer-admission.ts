import 'server-only';

import { pool } from '@kilocode/web-shared/lib/drizzle';

type WriterPool = {
  options: { max: number };
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
};

type QueueSource = 'queue' | 'queue_vercel';
type RejectionReason = 'queue_limit' | 'pool_waiting' | 'pool_busy';
type Admission =
  | { admitted: false; reason: RejectionReason }
  | { admitted: true; release: () => void };
type PoolGauges = { total: number; idle: number; waiting: number };
type SlotWait = { slotWaitMs: number; waited: boolean };
type Waiter = { settle: (reason: RejectionReason | null, gauges: PoolGauges) => void };

const IMMEDIATE: SlotWait = { slotWaitMs: 0, waited: false };

/** Per-runtime writer bound, not a reservation of connections or global DB capacity. */
export function createQueueWriterAdmission(writerPool: WriterPool) {
  const poolMax = writerPool.options.max;
  const limit = Math.max(1, poolMax - 2);
  let active = 0;
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

  function report(
    source: QueueSource,
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
            outcome: reason === null ? 'admitted' : 'rejected',
            reason,
            active,
            limit,
            pool_max: poolMax,
            pool: gauges,
            sample_rate: sampleRate,
            ...(wait ? { slot_wait_ms: wait.slotWaitMs } : {}),
            ...(wait?.waited && reason !== null ? { waited: true } : {}),
            ...(reason !== null ? { usage_id: usageId } : {}),
          })
        );
      }
    } catch {
      // Diagnostics cannot change admission or leak a reserved slot.
    }
  }

  function heldSlot(): Admission {
    let released = false;
    return {
      admitted: true,
      release() {
        if (released) return;
        released = true;
        passOrFreeSlot();
      },
    };
  }

  function passOrFreeSlot() {
    for (let waiter = waiters.shift(); waiter; waiter = waiters.shift()) {
      const gauges = readGauges();
      const reason = poolReason(gauges);
      waiter.settle(reason, gauges);
      if (reason === null) return;
    }
    active--;
  }

  function decideNow(source: QueueSource, usageId: string, wait: SlotWait | null): Admission {
    const gauges = readGauges();
    const reason = active >= limit ? 'queue_limit' : poolReason(gauges);
    // Reserve synchronously: concurrent requests can all see an empty pool queue.
    if (reason === null) active++;
    report(source, usageId, reason, gauges, wait);
    return reason === null ? heldSlot() : { admitted: false, reason };
  }

  return {
    tryAcquire(source: QueueSource, usageId: string): Admission {
      return decideNow(source, usageId, null);
    },

    /**
     * Waits up to `maxWaitMs` in a FIFO of at most `limit` callers when this
     * runtime's own slots are full; waiting pool clients still reject immediately.
     * `pool_busy` is deferred to grant time at the limit: this runtime's own active
     * writers can occupy the pool, so checked-out connections are not independent
     * evidence of additional pressure there. Both pool reasons are rechecked at grant.
     */
    acquire(
      source: QueueSource,
      usageId: string,
      { maxWaitMs, signal }: { maxWaitMs: number; signal?: AbortSignal }
    ): Promise<Admission> {
      if (active >= limit) {
        const gauges = readGauges();
        if (gauges.waiting > 0) {
          report(source, usageId, 'pool_waiting', gauges, IMMEDIATE);
          return Promise.resolve({ admitted: false, reason: 'pool_waiting' });
        }
      }
      const canWait =
        active >= limit && maxWaitMs > 0 && waiters.length < limit && !signal?.aborted;
      if (!canWait) return Promise.resolve(decideNow(source, usageId, IMMEDIATE));

      return new Promise(resolve => {
        const enqueuedAt = Date.now();
        const settle = (reason: RejectionReason | null, gauges: PoolGauges) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', leave);
          report(source, usageId, reason, gauges, {
            slotWaitMs: Date.now() - enqueuedAt,
            waited: true,
          });
          resolve(reason === null ? heldSlot() : { admitted: false, reason });
        };
        const waiter: Waiter = { settle };
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
