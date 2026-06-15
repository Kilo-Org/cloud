export const CLEANUP_BATCH_SIZE = 25;
export const CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1000;
export const PENDING_DEPLOYMENT_CLEANUP_MS = 10 * 60 * 1000;

type CleanupTarget = 'mapping' | 'banner' | 'worker' | 'retry-state' | 'row-delete';

export type CleanupFailure = {
  target: CleanupTarget;
  error: unknown;
};

export async function removeExpiredDeployment(
  workerName: string,
  dependencies: {
    deleteMapping(workerName: string): Promise<void>;
    disableBanner(workerName: string): Promise<void>;
    deleteWorker(workerName: string): Promise<void>;
  }
): Promise<CleanupFailure[]> {
  const [mapping, banner, worker] = await Promise.allSettled([
    dependencies.deleteMapping(workerName),
    dependencies.disableBanner(workerName),
    dependencies.deleteWorker(workerName),
  ]);
  const failures: CleanupFailure[] = [];

  if (mapping.status === 'rejected') {
    failures.push({ target: 'mapping', error: mapping.reason });
  }
  if (banner.status === 'rejected') {
    failures.push({ target: 'banner', error: banner.reason });
  }
  if (worker.status === 'rejected') {
    failures.push({ target: 'worker', error: worker.reason });
  }

  return failures;
}

export function nextCleanupRetryAt(now: number): number {
  return now + CLEANUP_RETRY_DELAY_MS;
}
