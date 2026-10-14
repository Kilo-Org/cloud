import { rename, writeFile } from 'node:fs/promises';

export function createScreenBudget(maxUsd: number, initialSpendUsd = 0) {
  let spentUsd = initialSpendUsd;
  let reservedUsd = 0;
  let activeReservations = 0;
  let stopped = false;
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  return {
    get spentUsd() { return spentUsd; },
    get reservedUsd() { return reservedUsd; },
    stop() {
      stopped = true;
      notify();
    },
    async reserve(amountUsd: number) {
      while (true) {
        if (stopped || spentUsd >= maxUsd ||
          (activeReservations === 0 && amountUsd > maxUsd - spentUsd)) return null;
        if (spentUsd + reservedUsd + amountUsd <= maxUsd) {
          reservedUsd += amountUsd;
          activeReservations++;
          let settled = false;
          return {
            settle(actualCostUsd: number) {
              if (settled) throw new Error('Screen budget reservation already settled');
              settled = true;
              reservedUsd = Math.max(0, reservedUsd - amountUsd);
              activeReservations--;
              if (activeReservations === 0) reservedUsd = 0;
              spentUsd += actualCostUsd;
              notify();
            },
          };
        }
        await new Promise<void>(resolve => waiters.add(resolve));
      }
    },
  };
}

export async function runScreenWorkerPool<Job>(
  jobs: Iterable<Job>,
  concurrency: number,
  run: (job: Job) => Promise<void>
) {
  const iterator = jobs[Symbol.iterator]();
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      const next = iterator.next();
      if (next.done) return;
      try {
        await run(next.value);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, worker));
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason;
  }
}

export function createScreenCheckpoint(path: string, snapshot: () => unknown) {
  let writes = Promise.resolve();
  return () => {
    const json = `${JSON.stringify(snapshot(), null, 2)}\n`;
    writes = writes.then(async () => {
      await writeFile(`${path}.partial`, json);
      await rename(`${path}.partial`, path);
    });
    return writes;
  };
}
