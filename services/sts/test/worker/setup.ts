import { runInDurableObject } from 'cloudflare:test';
import { afterEach } from 'vitest';
import { getRefresherStub } from '../../src/dos/stubs';
import { config, env } from './test-env';

const SETTLE_POLL_MS = 5;
const SETTLE_DEADLINE_MS = 2_000;
const QUIET_CHECKS = 2;

async function deleteRefresherAlarm(): Promise<boolean> {
  return runInDurableObject(getRefresherStub(env, config), async (_instance, state) => {
    if ((await state.storage.getAlarm()) === null) return false;
    await state.storage.deleteAlarm();
    return true;
  });
}

/**
 * Disarms the refresher after every test. Every bundle read arms the refresher's alarm through
 * `BundleDO.checkRefresher`, and under the offline manager a read fails with 503, so the object
 * records a failure and re-arms itself with backoff for as long as the test worker lives. An alarm
 * still armed (or running) when the runner pops a file's storage stack makes workerd retry the
 * handler against a broken output gate, and the run never finishes. The next test's
 * `resetRefresherObject` is too late at a file boundary, because the storage stack is popped first.
 *
 * A handler already in flight gives up the input gate while its manager fetch is pending, so it can
 * re-arm after the first delete. The loop keeps deleting until the alarm reads null on consecutive
 * checks, and fails the test if it is still re-arming at the deadline, rather than leaving it to
 * wedge the run.
 */
afterEach(async () => {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  let quiet = 0;
  while (quiet < QUIET_CHECKS) {
    if (Date.now() > deadline) {
      throw new Error(
        `refresher alarm still re-arming ${SETTLE_DEADLINE_MS} ms after the test; teardown cannot disarm it`,
      );
    }
    quiet = (await deleteRefresherAlarm()) ? 0 : quiet + 1;
    if (quiet < QUIET_CHECKS) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, SETTLE_POLL_MS);
      await promise;
    }
  }
});
