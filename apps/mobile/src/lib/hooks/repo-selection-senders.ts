type RepoSelectionDelta = {
  add: (number | string)[];
  remove: (number | string)[];
};

export type RepoSelectionSaveVars = RepoSelectionDelta & {
  optimisticSelection: (number | string)[];
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
};

// One pending debounced send per scope+platform. The timer closes over the
// sender state, so a remount never retargets an older timer. `serverSelection`
// is the last server-confirmed selection; `pendingSelection` is the latest
// user-intended selection and is null while nothing is pending. The store lives
// outside the hook so a pending send survives a remount, and is cleared at an
// account boundary (see `clearSessionScopedState`).
const repoSelectionSenders = new Map<string, RepoSelectionSender>();

export function getRepoSelectionSender(key: string): RepoSelectionSender {
  let sender = repoSelectionSenders.get(key);
  if (!sender) {
    sender = { timer: null, pendingSelection: null, serverSelection: null, mutate: null };
    repoSelectionSenders.set(key, sender);
  }
  return sender;
}

/**
 * Cancels every pending debounced send and drops the stored pending/server
 * selections. Called at an account boundary: the personal scope key
 * (`personal:<platform>`) is device-global, so without this a pending toggle or
 * baseline left by the previous account would be re-applied and sent under the
 * next account's credentials, rewriting its selected repositories.
 */
export function clearRepoSelectionSenders(): void {
  for (const sender of repoSelectionSenders.values()) {
    if (sender.timer) {
      clearTimeout(sender.timer);
    }
  }
  repoSelectionSenders.clear();
}
