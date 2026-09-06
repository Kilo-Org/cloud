import { withTimeoutAndAbort } from '../utils.js';
import type { OwnedProcessScope } from './owned-processes.js';
import type { NativeOperationTarget, NativeRetirement } from './session-operation-cleanup.js';

export type RuntimeCleanupEntry<Root> = {
  directory: string;
  runtimeId: string;
  abort: AbortController;
  roots: Set<Root>;
  kiloClient?: NativeOperationTarget['client'];
  processes?: OwnedProcessScope;
  processIssued?: boolean;
  starting?: Promise<unknown>;
  stopped?: Promise<void>;
  retiring?: Promise<NativeRetirement>;
  retirementResult?: NativeRetirement;
};

export function retireWorktreeRuntime<Entry extends RuntimeCleanupEntry<Root>, Root>(
  entry: Entry,
  requested: number | undefined,
  target: NativeOperationTarget | undefined,
  deps: {
    cleanupDeadline: (entry: Entry, requested?: number) => number;
    unregisterRoot: (root: Root) => void;
    removeEntry: (entry: Entry) => void;
  }
): Promise<NativeRetirement> {
  if (
    target &&
    (target.runtimeId !== entry.runtimeId ||
      (target.client !== undefined && target.client !== entry.kiloClient))
  )
    return Promise.resolve('stale');
  const deadlineAt = deps.cleanupDeadline(entry, requested);
  if (entry.retiring) return entry.retiring;
  const completion = Promise.withResolvers<NativeRetirement>();
  entry.retiring = completion.promise;
  const processes =
    entry.processes?.stop(deadlineAt) ?? Promise.resolve(entry.processIssued !== true);
  entry.abort.abort();
  for (const root of [...entry.roots]) deps.unregisterRoot(root);
  const cleanup = async (): Promise<NativeRetirement> => {
    await Promise.resolve(entry.starting).catch(() => undefined);
    if (!(await processes) || Date.now() >= deps.cleanupDeadline(entry)) return 'unconfirmed';
    deps.removeEntry(entry);
    return 'retired';
  };
  void withTimeoutAndAbort(cleanup(), {
    timeoutMs: Math.max(1, deadlineAt - Date.now()),
    timeoutMessage: 'Owned native runtime cleanup expired',
    abortMessage: 'Owned native runtime cleanup cancelled',
  }).then(
    result => {
      entry.retirementResult = result;
      completion.resolve(result);
    },
    () => {
      entry.retirementResult = 'unconfirmed';
      completion.resolve('unconfirmed');
    }
  );
  return completion.promise;
}
