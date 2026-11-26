import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { createServiceTokens } from './client';
import type { ServiceTokens } from './types';

/**
 * STS answers a mint over the binding within its 5 s signer deadline; the rest is transit and a
 * loaded isolate.
 */
export const WORKER_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * The STS entrypoint as a consumer's service binding exposes it. A Worker binds the class as
 * `{ binding: "STS", service: "sts", entrypoint: "SecretsBroker", props: { caller } }`.
 */
export type MintBinding = {
  mintTokens(request: MintRequest): Promise<MintResult>;
};

/** Mints service tokens over the account-internal service binding (identity `worker-binding`). */
export function createWorkerServiceTokens(binding: MintBinding): ServiceTokens {
  return createServiceTokens(
    async request => {
      const result = await binding.mintTokens(request);
      // workerd gives every object an RPC call returns a disposer. Until it runs, the call stays
      // open: the request that made it does not finish, and STS's side ends as canceled when that
      // request finally does. The result is plain data, so it stays readable after disposal.
      // https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
      (result as Partial<Disposable>)[Symbol.dispose]?.();
      return result;
    },
    { attemptTimeoutMs: WORKER_ATTEMPT_TIMEOUT_MS }
  );
}
