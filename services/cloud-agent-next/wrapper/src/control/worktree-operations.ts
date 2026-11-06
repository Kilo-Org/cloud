const deletingDirectories = new Set<string>();
const operations = new Map<string, Set<Promise<unknown>>>();

export function assertDirectoryActive(directory: string): void {
  if (deletingDirectories.has(directory)) throw new Error('worktree_deleting');
}

export function runDirectoryOperation<T>(
  directory: string,
  operation: () => Promise<T>
): Promise<T> {
  if (deletingDirectories.has(directory)) return Promise.reject(new Error('worktree_deleting'));
  const pending = Promise.resolve().then(() => {
    if (deletingDirectories.has(directory)) throw new Error('worktree_deleting');
    return operation();
  });
  const active = operations.get(directory) ?? new Set<Promise<unknown>>();
  active.add(pending);
  operations.set(directory, active);
  return pending.finally(() => {
    active.delete(pending);
    if (active.size === 0) operations.delete(directory);
  });
}

export async function fenceDirectoryOperations(directory: string): Promise<void> {
  deletingDirectories.add(directory);
  await Promise.allSettled([...(operations.get(directory) ?? [])]);
}

export function resetDirectoryOperationState(): void {
  deletingDirectories.clear();
  operations.clear();
}
