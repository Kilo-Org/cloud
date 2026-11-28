export { SecretsBroker } from './broker';
export { BundleDO } from './dos/BundleDO';
export { DenialDO } from './dos/DenialDO';
export { DeployTokenDO } from './dos/DeployTokenDO';
export { LeaseDO } from './dos/LeaseDO';
export { RefresherDO } from './dos/RefresherDO';
export { SignerDO } from './dos/SignerDO';
export { TokenKeySetDO } from './dos/TokenKeySetDO';
export { TokenSignerDO } from './dos/TokenSignerDO';

import { withDORetry } from '@kilocode/worker-utils';
import { getLeaseStub, getRefresherStub } from './dos/stubs';
import { readConfig, type Env } from './env';
import { handleRequest } from './http';

/**
 * The cron confirms the refresher's alarm loop, so bundles are refreshed (and a deploy's policy
 * change recorded) without waiting for the first read, and, while replicas are configured, the
 * lease object's alarm loop, so replica sessions are swept without a lease call (README "Replica
 * sessions"). Both calls are idempotent.
 */
async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const config = readConfig(env);
  await Promise.all([
    withDORetry(
      () => getRefresherStub(env, config),
      stub => stub.ensureStarted(),
      'sts.scheduled.ensureStarted'
    ),
    config.replicaSweepBindings.length === 0
      ? undefined
      : withDORetry(
          () => getLeaseStub(env, config),
          stub => stub.ensureSweeping(),
          'sts.scheduled.ensureSweeping'
        ),
  ]);
}

export default {
  fetch: handleRequest,
  scheduled,
} satisfies ExportedHandler<Env>;
