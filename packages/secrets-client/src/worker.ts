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
  return createSecrets(request => binding.getBundle(request));
}
