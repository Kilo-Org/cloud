import lockfile from 'proper-lockfile';

export function withProcessLock<T>(lockPath: string, label: string, mutate: () => T): T {
  let release: (() => void) | undefined;
  try {
    release = lockfile.lockSync(lockPath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 5000,
      update: 1000,
    });
  } catch (error) {
    throw new Error(`${label} is being updated concurrently`, { cause: error });
  }

  try {
    return mutate();
  } finally {
    release();
  }
}
