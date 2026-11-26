import { WorkerEntrypoint } from 'cloudflare:workers';
import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import {
  createWorkerSecrets,
  type BundleBinding,
  type Secrets,
  type SecretsExecutionContext,
} from '../../../src/index';

/**
 * Test-only Worker for rpc-runtime.test.ts. Its service bindings point at its own entrypoints,
 * so every bundle read is a real RPC call. `SecretsBroker` answers as STS does: it returns the
 * bundle store's RPC result as it came, so the object carries the disposer workerd gave it.
 */
type Env = { STS: BundleBinding; STORE: { read(): Promise<BundleResult> } };

const OK: BundleResult = {
  status: 'ok',
  workload: 'o11y',
  environment: 'production',
  etag: '"0123456789abcdef"',
  stale: false,
  fetchedAt: '2026-11-25T00:00:00.000Z',
  secrets: { O11Y_CF_AE_API_TOKEN: { value: 'ae-token', version: 1 } },
  missing: [],
};

/**
 * How long after returning the broker checks whether its call is still open. A caller that
 * disposes the result ends the call within milliseconds; 2.5 s leaves room for a stalled machine.
 */
const BROKER_PROBE_MS = 2_500;
/** How long the caller keeps working after its read: past the probe, so a held call is caught. */
const CALLER_WORK_MS = 5_000;

/** Broker calls whose context was still open `BROKER_PROBE_MS` after they returned. */
let brokerOpenAfterReturn = 0;

export class BundleStore extends WorkerEntrypoint<Env> {
  async read(): Promise<BundleResult> {
    return OK;
  }
}

export class SecretsBroker extends WorkerEntrypoint<Env> {
  async getBundle(_request: BundleRequest): Promise<BundleResult> {
    const result = await this.env.STORE.read();
    // workerd cancels this timer when the call's context ends, so it fires only while a caller
    // still holds the call open.
    setTimeout(() => brokerOpenAfterReturn++, BROKER_PROBE_MS);
    return result;
  }
}

let secrets: Secrets | undefined;

export default {
  async fetch(_request: Request, env: Env, ctx: SecretsExecutionContext): Promise<Response> {
    secrets ??= createWorkerSecrets(env.STS);
    const value = await secrets.get('O11Y_CF_AE_API_TOKEN', ctx);
    // The request keeps working past the broker's probe, as a relay batch does after its read.
    const work = Promise.withResolvers<void>();
    setTimeout(work.resolve, CALLER_WORK_MS);
    await work.promise;
    return Response.json({ value, brokerOpenAfterReturn });
  },
};
