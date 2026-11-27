import { runInDurableObject } from 'cloudflare:test';
import { afterEach } from 'vitest';
import { getRefresherStub } from '../../src/dos/stubs';
import { config, env } from './test-env';

/**
 * Disarms the refresher after every test. Every bundle read arms the refresher's alarm through
 * `BundleDO.checkRefresher`, and under the offline manager a read fails with 503, so the object
 * records a failure and re-arms itself with backoff for as long as the test worker lives. An alarm
 * still armed (or already running) when the runner pops the file's storage stack makes workerd
 * retry the handler against a broken output gate, and the run never finishes. Clearing it in the
 * next test's `resetRefresherObject` is too late: that runs in the next file's beforeEach.
 */
afterEach(async () => {
  await runInDurableObject(getRefresherStub(env, config), async (_instance, state) => {
    if ((await state.storage.getAlarm()) !== null) await state.storage.deleteAlarm();
  });
});
