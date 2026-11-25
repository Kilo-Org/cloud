import {
  BundleRequestSchema,
  WorkloadNameSchema,
  type BundleRequest,
  type BundleResult,
} from '@kilocode/sts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { getBundleStub } from './dos/stubs';
import { readConfig, type Env, type StsConfig } from './env';
import { policyExists, policyFor } from './policy';

export type SecretsBrokerProps = { caller: string };

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
    if (!props.success) return { status: 'denied', reason: 'identity_rejected' };
    return await serveWorkerCall(this.env, config, props.data.caller, request);
  }
}

export async function serveWorkerCall(
  env: Env,
  config: StsConfig,
  caller: string,
  request: BundleRequest
): Promise<BundleResult> {
  const policy = policyFor(config.environment, caller);
  if (policy === null) {
    return {
      status: 'denied',
      reason: policyExists(caller) ? 'environment_mismatch' : 'unknown_workload',
    };
  }
  if (policy.identity.kind !== 'worker-binding') {
    return { status: 'denied', reason: 'identity_rejected' };
  }
  return await serveBundle(env, config, caller, request);
}

/**
 * One hop to the workload's bundle object. Deliberately not retried: a delivery appends an audit
 * row, so a retry after a committed append would audit the same read twice.
 */
export async function serveBundle(
  env: Env,
  config: StsConfig,
  workload: string,
  request: BundleRequest
): Promise<BundleResult> {
  const parsed = BundleRequestSchema.parse(request);
  return await getBundleStub(env, config, workload).getBundle(workload, config.environment, parsed);
}
