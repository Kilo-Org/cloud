const awaitSettled = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // Sequencing only — callers observe their own run outcome.
  }
};

export interface SerialAsyncChain {
  readonly enqueue: <TValue>(work: () => Promise<TValue>) => Promise<TValue>;
}

export const createSerialAsyncChain = (): SerialAsyncChain => {
  let chain: Promise<unknown> | undefined = undefined;

  return {
    enqueue: <TValue>(work: () => Promise<TValue>): Promise<TValue> => {
      const previous = chain;
      const run = (async (): Promise<TValue> => {
        if (previous !== undefined) {
          await awaitSettled(previous);
        }

        return work();
      })();
      chain = awaitSettled(run);
      return run;
    },
  };
};
