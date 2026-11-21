/* eslint-disable typescript-eslint/consistent-type-definitions -- AGENTS.md prefers type over interface */
export type MaybePromise<Value> = Promise<Value> | Value;

/** WXT keys carry their area as a prefix; these modules only use `local:` and `session:`. */
export type LocalAgentStorageKey = `local:${string}` | `session:${string}`;

/** The WXT storage surface these modules use; both areas go through one object. */
export type LocalAgentStorageArea = {
  getItem(key: LocalAgentStorageKey): MaybePromise<unknown>;
  setItem(key: LocalAgentStorageKey, value: unknown): MaybePromise<void>;
  removeItem(key: LocalAgentStorageKey): MaybePromise<void>;
};

export type LocalAgentStorageWatch = (
  key: LocalAgentStorageKey,
  callback: () => void
) => () => void;

/**
 * Read-modify-write on one storage key must not interleave: `session.open` from
 * two controllers can arrive in the same tick. Every registry mutation runs
 * through one queue.
 */
export const createSerialTaskQueue = (): (<Value>(
  task: () => Promise<Value>
) => Promise<Value>) => {
  let tail: Promise<void> = Promise.resolve();

  return <Value>(task: () => Promise<Value>): Promise<Value> => {
    const previous = tail;
    const result = (async (): Promise<Value> => {
      await previous;

      return task();
    })();

    // The tail settles whatever the task does, so a failed task cannot block later ones.
    tail = (async (): Promise<void> => {
      try {
        await result;
      } catch {
        // The caller observes the rejection through `result`.
      }
    })();

    return result;
  };
};
