import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';

export const REPO_SELECTION_DEBOUNCE_MS = 500;

export type RepoSelectionDelta = {
  add: (number | string)[];
  remove: (number | string)[];
};

export type RepoSelectionSaveVars = RepoSelectionDelta & {
  optimisticSelection: (number | string)[];
  // The auth epoch that armed this send. Its callbacks act only while that
  // epoch is current.
  authEpoch: number;
};

export type RepoSelectionSender = {
  timer: ReturnType<typeof setTimeout> | null;
  // The latest user-intended selection. Null means no toggle is pending.
  pendingSelection: (number | string)[] | null;
  // The last server-confirmed selection. Null means the server state is not
  // yet known (no toggle and no refetch have synced it).
  serverSelection: (number | string)[] | null;
  // The mutation trigger of the hook instance that currently owns this key.
  mutate: ((vars: RepoSelectionSaveVars) => void) | null;
  // The auth epoch this sender's selections belong to.
  epoch: number;
};

// One pending debounced send per scope+platform. The timer closes over the
// sender state, so a remount never retargets an older timer. `serverSelection`
// is the last server-confirmed selection; `pendingSelection` is the latest
// user-intended selection and is null while nothing is pending. Each entry
// records the auth epoch it was created under, and an entry created under
// another epoch is replaced before it is read.
const repoSelectionSenders = new Map<string, RepoSelectionSender>();

/**
 * True while `epoch` is the current auth epoch and no sign-out teardown is in
 * flight. The debounce fire, the refetch resync, and the save callbacks check
 * it before they read or write the shared sender entry.
 */
export function isRepoSelectionEpochCurrent(epoch: number): boolean {
  return isCurrentAuthEpoch(epoch) && !isSignOutActive();
}

export function getRepoSelectionSender(key: string, epoch: number): RepoSelectionSender {
  const existing = repoSelectionSenders.get(key);
  if (existing?.epoch === epoch) {
    return existing;
  }
  clearTimeout(existing?.timer ?? undefined);
  const sender: RepoSelectionSender = {
    timer: null,
    pendingSelection: null,
    serverSelection: null,
    mutate: null,
    epoch,
  };
  repoSelectionSenders.set(key, sender);
  return sender;
}

/**
 * Drops every pending debounced send together with its armed timer.
 * `clearSessionScopedState` calls this from the account boundary.
 */
export function clearRepoSelectionSenders(): void {
  for (const sender of repoSelectionSenders.values()) {
    clearTimeout(sender.timer ?? undefined);
  }
  repoSelectionSenders.clear();
}

export function sameSelection(
  a: (number | string)[] | null,
  b: (number | string)[] | null
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every(id => b.includes(id));
}

// Schedules the trailing-edge 500ms send. The delta is computed at fire time
// from the module-level pending/server selections, so no intermediate rapid
// toggle is lost and a refetch that clobbers the optimistic cache cannot
// collapse the send to an empty delta.
export function scheduleSend(sender: RepoSelectionSender): void {
  if (sender.timer) {
    clearTimeout(sender.timer);
  }
  sender.timer = setTimeout(() => {
    sender.timer = null;
    // The fire submits only while the epoch that armed it is current.
    if (!isRepoSelectionEpochCurrent(sender.epoch)) {
      sender.pendingSelection = null;
      return;
    }
    const pending = sender.pendingSelection;
    const server = sender.serverSelection ?? [];
    if (pending === null) {
      return;
    }
    const add = pending.filter(id => !server.includes(id));
    const remove = server.filter(id => !pending.includes(id));
    if (add.length === 0 && remove.length === 0) {
      // The intent now equals the server state, so nothing is left to send.
      // Clear it so a later refetch does not mistake it for live user intent.
      sender.pendingSelection = null;
      return;
    }
    sender.mutate?.({ add, remove, optimisticSelection: pending, authEpoch: sender.epoch });
  }, REPO_SELECTION_DEBOUNCE_MS);
}
