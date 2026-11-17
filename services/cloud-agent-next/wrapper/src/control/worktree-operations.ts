const deletingDirectories = new Set<string>();
const operations = new Map<string, Set<Promise<unknown>>>();
const rewriteDirectories = new Set<string>();
const rewriteQueues = new Map<string, Promise<unknown>>();

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

/**
 * True while a branch rewrite owns a directory. Prompt admission parks new
 * prompts instead of dispatching them while this is set, so a Sync/Restack and
 * a new turn can never rewrite and read the same checkout concurrently.
 */
export function isDirectoryRewriteActive(directory: string): boolean {
  return rewriteDirectories.has(directory);
}

/**
 * Serialize a branch rewrite per directory and hold the directory against prompt
 * admission until it finishes. Rewrites for one directory queue behind each
 * other; a pending rewrite still blocks new prompts.
 */
export function runDirectoryRewrite<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  rewriteDirectories.add(directory);
  const previous = rewriteQueues.get(directory) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => runDirectoryOperation(directory, operation));
  const tracked = current.finally(() => {
    if (rewriteQueues.get(directory) === tracked) {
      rewriteQueues.delete(directory);
      rewriteDirectories.delete(directory);
    }
  });
  rewriteQueues.set(directory, tracked);
  return tracked;
}

export async function fenceDirectoryOperations(directory: string): Promise<void> {
  deletingDirectories.add(directory);
  await Promise.allSettled([...(operations.get(directory) ?? [])]);
}

export function resetDirectoryOperationState(): void {
  deletingDirectories.clear();
  operations.clear();
  rewriteDirectories.clear();
  rewriteQueues.clear();
}
