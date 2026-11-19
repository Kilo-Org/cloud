/** Provider reconciliation state stays outside the immutable build input. */
export type BuilderLifecycleState = {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
  clear(): Promise<void>;
  /** Read and write synchronously in one transaction; transitions must not return promises. */
  update(transition: (current: unknown) => unknown): Promise<unknown>;
};

export function createBuilderLifecycleState(deps: {
  read(): unknown;
  write(value: unknown): void;
  transaction<T>(write: () => T): T;
}): BuilderLifecycleState {
  return {
    get: async () => deps.read(),
    set: async value => deps.write(value),
    clear: async () => deps.write(undefined),
    update: async transition =>
      deps.transaction(() => {
        const next = transition(deps.read());
        if (
          next !== null &&
          (typeof next === 'object' || typeof next === 'function') &&
          'then' in next &&
          typeof next.then === 'function'
        )
          throw new Error('Builder state transitions must be synchronous');
        deps.write(next);
        return next;
      }),
  };
}
