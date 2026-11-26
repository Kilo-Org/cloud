import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { createSecrets } from './client';
import type { Secrets } from './types';

/**
 * The STS entrypoint as a consumer's service binding exposes it. A Worker binds the class as
 * `{ binding: "STS", service: "sts", entrypoint: "SecretsBroker", props: { caller } }`.
 */
export type BundleBinding = {
  getBundle(request: BundleRequest): Promise<BundleResult>;
};

/** Reads the workload's whole bundle over the account-internal service binding. */
export function createWorkerSecrets(binding: BundleBinding): Secrets {
  return createSecrets(async request => {
    const result = await binding.getBundle(request);
    // workerd gives every object an RPC call returns a disposer. Until it runs, the call stays
    // open: the request that made it does not finish, and STS's side ends as canceled when that
    // request finally does. The bundle is plain data, so it stays readable after disposal.
    // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
    (result as Partial<Disposable>)[Symbol.dispose]?.();
    return result;
  });
}
