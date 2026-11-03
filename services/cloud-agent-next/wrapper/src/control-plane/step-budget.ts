/**
 * A time allowance shared by every operation of one kind in a preparation, so
 * that N roots get one deadline for the step and not N of them. Each `spend`
 * receives what is left and its elapsed time is deducted, whatever the outcome.
 */
export type StepBudget = {
  spend<T>(run: (remainingMs: number) => Promise<T>): Promise<T>;
};

export function createStepBudget(totalMs: number, now: () => number = Date.now): StepBudget {
  let usedMs = 0;
  return {
    async spend(run) {
      const startedAt = now();
      try {
        return await run(Math.max(0, totalMs - usedMs));
      } finally {
        usedMs += now() - startedAt;
      }
    },
  };
}
