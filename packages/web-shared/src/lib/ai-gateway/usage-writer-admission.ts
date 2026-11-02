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

/** Per-runtime writer bound, not a reservation of connections or global DB capacity. */
export function createQueueWriterAdmission(writerPool: WriterPool) {
  const poolMax = writerPool.options.max;
  const limit = Math.max(1, poolMax - 2);
  let active = 0;

  return {
    tryAcquire(source: QueueSource): Admission {
      const gauges = {
        total: writerPool.totalCount,
        idle: writerPool.idleCount,
        waiting: writerPool.waitingCount,
      };
      const reason: RejectionReason | null =
        active >= limit
          ? 'queue_limit'
          : gauges.waiting > 0
            ? 'pool_waiting'
            : gauges.total - gauges.idle >= limit
              ? 'pool_busy'
              : null;
      // Reserve synchronously: concurrent requests can all see an empty pool queue.
      if (reason === null) active++;
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
            })
          );
        }
      } catch {
        // Diagnostics cannot change admission or leak a reserved slot.
      }
      if (reason !== null) return { admitted: false, reason };

      let released = false;
      return {
        admitted: true,
        release() {
          if (released) return;
          released = true;
          active--;
        },
      };
    },
  };
}

export const queueWriterAdmission = createQueueWriterAdmission(pool);
