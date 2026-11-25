import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { SecretsBroker } from '../../src/broker';
import { getBundleStub } from '../../src/dos/stubs';
import { readConfig, type Env } from '../../src/env';
import { workloadPolicyHash } from '../../src/policy';

export { BundleDO, DenialDO, RefresherDO, SignerDO } from '../../src/index';

/**
 * Test-only Worker for broker-rpc.test.ts; never deployed. `BROKER` binds its own `ProbeBroker`
 * entrypoint with `props.caller`, so the bundle read is a real RPC call into STS's broker code.
 */
type ProbeEnv = Env & { BROKER: Service<ProbeBroker> };

/** Broker calls whose context was still open 1 s after they returned. */
let brokerOpenAfterReturn = 0;

export class ProbeBroker extends SecretsBroker {
  override async getBundle(request: BundleRequest): Promise<BundleResult> {
    const result = await super.getBundle(request);
    // workerd cancels this timer when the call's context ends, so it fires only while a caller
    // still holds the call open.
    setTimeout(() => {
      brokerOpenAfterReturn += 1;
    }, 1_000);
    return result;
  }
}

export default {
  async fetch(_request: Request, env: ProbeEnv): Promise<Response> {
    const config = readConfig(env);
    await getBundleStub(env, config, 'o11y').putBundle({
      workload: 'o11y',
      secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 7, id: 'id-ae' } },
      missing: [],
      fetchedAt: new Date().toISOString(),
      policyHash: await workloadPolicyHash('o11y'),
      stale: false,
    });
    // A caller that never disposes what it received, then keeps working past the broker's timer.
    const result = await env.BROKER.getBundle({});
    const work = Promise.withResolvers<void>();
    setTimeout(work.resolve, 1_500);
    await work.promise;
    return Response.json({ status: result.status, brokerOpenAfterReturn });
  },
} satisfies ExportedHandler<ProbeEnv>;
