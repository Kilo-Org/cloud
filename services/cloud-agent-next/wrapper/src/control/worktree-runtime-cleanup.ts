import { withTimeoutAndAbort } from '../utils.js';
import {
  OWNED_PROCESS_OBSERVATION_TIMEOUT_MS,
  type DirectProcessObserver,
  type OwnedProcessScope,
} from './owned-processes.js';
import type { NativeOperationTarget, NativeRetirement } from './session-operation-cleanup.js';

export function stopWithinCleanupBudget(
  processes: OwnedProcessScope | undefined,
  processIssued: boolean,
  deadlineAt: number,
  stopped?: Promise<void>
): Promise<boolean> {
  if (!processes) return stopped?.then(() => true) ?? Promise.resolve(processIssued !== true);
  const now = Date.now();
  const observationReserve = Math.min(
    OWNED_PROCESS_OBSERVATION_TIMEOUT_MS,
    Math.max(0, (deadlineAt - now) / 2)
  );
  const stopDeadlineAt = Math.max(now, deadlineAt - observationReserve);
  return processes.stop(stopDeadlineAt);
}

export async function settleNativeCleanup(options: {
  processes: OwnedProcessScope | undefined;
  processIssued: boolean;
  deadlineAt: number;
  stopped?: Promise<void>;
  observeDirect: (deadlineAt: number) => Promise<boolean>;
}): Promise<boolean> {
  const stoppedWithinBudget = stopWithinCleanupBudget(
    options.processes,
    options.processIssued,
    options.deadlineAt,
    options.stopped
  );
  if (await stoppedWithinBudget) return true;
  return options.observeDirect(options.deadlineAt);
}

export type RuntimeCleanupEntry<Root> = {
  directory: string;
  runtimeId: string;
  abort: AbortController;
  roots: Set<Root>;
  kiloClient?: NativeOperationTarget['client'];
  processes?: OwnedProcessScope;
  processObserver?: DirectProcessObserver;
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
    unverifiedCleanup: (entry: Entry, deadlineAt: number) => Promise<boolean>;
  }
): Promise<NativeRetirement> {
  if (
    target &&
    (target.runtimeId !== entry.runtimeId ||
      (target.client !== undefined && target.client !== entry.kiloClient))
  )
    return Promise.resolve('stale');
  const deadlineAt = deps.cleanupDeadline(entry, requested);
  if (entry.retiring) {
    void stopWithinCleanupBudget(
      entry.processes,
      entry.processIssued === true,
      deadlineAt,
      entry.stopped
    );
    return entry.retiring;
  }
  const completion = Promise.withResolvers<NativeRetirement>();
  entry.retiring = completion.promise;
  entry.abort.abort();
  for (const root of [...entry.roots]) deps.unregisterRoot(root);
  const cleanup = async (): Promise<NativeRetirement> => {
    const starting = entry.starting;
    await Promise.resolve(starting).catch(() => undefined);
    if (starting !== undefined && Date.now() >= deps.cleanupDeadline(entry)) return 'unconfirmed';
    const settled = await settleNativeCleanup({
      processes: entry.processes,
      processIssued: entry.processIssued === true,
      deadlineAt,
      stopped: entry.stopped,
      observeDirect: innerDeadlineAt => deps.unverifiedCleanup(entry, innerDeadlineAt),
    });
    if (!settled) return 'unconfirmed';
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
