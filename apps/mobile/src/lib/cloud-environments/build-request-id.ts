/**
 * One `requestId` per build attempt, kept until the server answers.
 *
 * The router documents the contract: a request retried after a lost response
 * reuses its `requestId`, and the server then returns the build that request
 * already started. A fresh id per press would instead start a second build or
 * answer `build_in_progress` for the build the first press started. The attempt
 * is one environment at one configuration revision: a new revision is a choice
 * of its own, and an answered attempt leaves nothing behind.
 */
export function createBuildRequestIds(createId: () => string) {
  const ids = new Map<string, string>();
  const keyFor = (environmentId: string, revision: number) => `${environmentId}:${revision}`;
  return {
    forAttempt(environmentId: string, revision: number): string {
      const key = keyFor(environmentId, revision);
      const existing = ids.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = createId();
      ids.set(key, created);
      return created;
    },
    answered(environmentId: string, revision: number): void {
      ids.delete(keyFor(environmentId, revision));
    },
  };
}
