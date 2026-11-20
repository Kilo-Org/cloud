export const WORKSPACE_REFRESH_DELAY_MS = 300;
export const WORKSPACE_REFRESH_BATCH_SIZE = 200;
export const WORKSPACE_REFRESH_TIMEOUT_MS = 30_000;

export function createWorkspaceRefreshCoordinator(
  refresh: (worktreeIds: string[]) => Promise<void>,
  onError: (error: unknown, worktreeIds: string[]) => void
) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let refreshing = false;

  const scheduleFlush = () => {
    if (disposed || refreshing || timer || pending.size === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, WORKSPACE_REFRESH_DELAY_MS);
  };
  const flush = async () => {
    if (disposed || refreshing) return;
    refreshing = true;
    const ids = [...pending];
    pending.clear();
    try {
      for (let start = 0; start < ids.length && !disposed; start += WORKSPACE_REFRESH_BATCH_SIZE) {
        const batch = ids.slice(start, start + WORKSPACE_REFRESH_BATCH_SIZE);
        try {
          await refresh(batch);
        } catch (error) {
          if (!disposed) onError(error, batch);
        }
      }
    } finally {
      refreshing = false;
      scheduleFlush();
    }
  };
  return {
    schedule(worktreeId: string) {
      if (disposed) return;
      pending.add(worktreeId);
      scheduleFlush();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
