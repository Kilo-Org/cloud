import {
  BundleRequestSchema,
  WorkloadNameSchema,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { recordDenial, type Denial } from './audit/denials';
import { BUNDLE_OBJECT_RETRY_AFTER_SECONDS } from './constants';
import { getBundleStub } from './dos/stubs';
import { readConfig, type Env, type StsConfig } from './env';
import { policyExists, policyFor } from './policy';

export type SecretsBrokerProps = { caller: string };

/** Runs work after the response, as `ExecutionContext.waitUntil` does. */
export type WaitUntil = (promise: Promise<unknown>) => void;

type DeniedReason = Denial['reason'];

const CallerPropsSchema = z.strictObject({ caller: WorkloadNameSchema });

/**
 * The in-account front door: a Worker binds this entrypoint with
 * `props: { caller: '<its own worker name>' }`, and STS authorizes on that value
 * against its policy files. Deploy-level trust, per design 6.4.
 */
export class SecretsBroker extends WorkerEntrypoint<Env, SecretsBrokerProps> {
  async getBundle(request: BundleRequest): Promise<BundleResult> {
    const config = readConfig(this.env);
    const props = CallerPropsSchema.safeParse(this.ctx.props);
    if (!props.success) {
      // No caller name to audit: a binding without valid props is a deploy error.
      console.warn('sts: bundle call refused: the binding carries no valid props.caller');
      return { status: 'denied', reason: 'identity_rejected' };
    }
    return await serveWorkerCall(this.env, config, props.data.caller, request, promise =>
      this.ctx.waitUntil(promise)
    );
  }
}

function refusalFor(config: StsConfig, caller: string): DeniedReason | null {
  const policy = policyFor(config.environment, caller);
  if (policy === null) return policyExists(caller) ? 'environment_mismatch' : 'unknown_workload';
  return policy.identity.kind === 'worker-binding' ? null : 'identity_rejected';
}

/** Refuses a caller without a worker-binding policy here, and audits the refusal. */
export async function serveWorkerCall(
  env: Env,
  config: StsConfig,
  caller: string,
  request: BundleRequest,
  waitUntil: WaitUntil
): Promise<BundleResult> {
  const reason = refusalFor(config, caller);
  if (reason !== null) {
    const hop = recordDenial(env, config, {
      channel: 'worker-binding',
      reason,
      actor: caller,
      claims: {},
    });
    if (hop !== null) waitUntil(hop);
    return { status: 'denied', reason };
  }
  return await serveBundle(env, config, caller, request);
}

/**
 * One hop to the workload's bundle object. Deliberately not retried: a delivery appends an audit
 * row, so a retry after a committed append would audit the same read twice. A failed hop answers
 * `unavailable`; the caller keeps its copy and retries after 30 seconds.
 *
 * The answer is a plain copy, and the bundle object's RPC result is disposed here. workerd gives
 * every object an RPC call returns a disposer, and a method that returns an object with a disposer
 * keeps its own context open until its caller disposes that object: STS would end only when the
 * calling Worker remembered to. https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export async function serveBundle(
  env: Env,
  config: StsConfig,
  workload: string,
  request: BundleRequest
): Promise<BundleResult> {
  const parsed = BundleRequestSchema.parse(request);
  // Partial: only a workerd RPC result carries a disposer, and only on its top-level object.
  let result: BundleResult & Partial<Disposable>;
  try {
    result = await getBundleStub(env, config, workload).getBundle(
      workload,
      config.environment,
      parsed
    );
  } catch (error) {
    console.error('sts: bundle object call failed', {
      workload,
      reason: error instanceof Error ? error.name : 'unknown',
    });
    return {
      status: 'unavailable',
      reason: 'internal',
      retryAfterSeconds: BUNDLE_OBJECT_RETRY_AFTER_SECONDS,
    };
  }
  try {
    // The disposer is non-enumerable, so the spread leaves it behind; nested values are plain data.
    return { ...result };
  } finally {
    result[Symbol.dispose]?.();
  }
}
