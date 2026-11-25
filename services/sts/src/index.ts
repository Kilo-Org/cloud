export { SecretsBroker } from './broker';
export { BundleDO } from './dos/BundleDO';
export { DenialDO } from './dos/DenialDO';
export { RefresherDO } from './dos/RefresherDO';
export { SignerDO } from './dos/SignerDO';
export { TokenSignerDO } from './dos/TokenSignerDO';

import { withDORetry } from '@kilocode/worker-utils';
import { getRefresherStub } from './dos/stubs';
import { readConfig, type Env } from './env';
import { handleRequest } from './http';

/**
 * The cron confirms the refresher's alarm loop, so bundles are refreshed (and a deploy's policy
 * change recorded) without waiting for the first read. `ensureStarted` is idempotent.
 */
async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const config = readConfig(env);
  await withDORetry(
    () => getRefresherStub(env, config),
    stub => stub.ensureStarted(),
    'sts.scheduled.ensureStarted'
  );
}

export default {
  fetch: handleRequest,
  scheduled,
} satisfies ExportedHandler<Env>;
