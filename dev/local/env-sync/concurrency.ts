const DEFAULT_ENV_SYNC_CONCURRENCY = 4;
const MAX_ENV_SYNC_CONCURRENCY = 32;

function resolveEnvSyncConcurrency(value = process.env.KILO_ENV_SYNC_CONCURRENCY): number {
  if (value === undefined || value === '') return DEFAULT_ENV_SYNC_CONCURRENCY;

  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_ENV_SYNC_CONCURRENCY) {
    throw new Error(
      `KILO_ENV_SYNC_CONCURRENCY must be an integer between 1 and ${MAX_ENV_SYNC_CONCURRENCY}`
    );
  }
  return concurrency;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return [];
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer');
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await map(values[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export { mapWithConcurrency, resolveEnvSyncConcurrency };
