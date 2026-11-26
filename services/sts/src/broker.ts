import {
  BundleRequestSchema,
  WorkloadNameSchema,
  type BundleRequest,
  type BundleResult,
  type LeaseRequest,
  type LeaseResult,
  type LeaseRevokeResult,
  type MintRequest,
  type MintResult,
} from '@kilocode/sts-contracts';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { recordDenial, type BundleDenial } from './audit/denials';
import { BUNDLE_OBJECT_DEADLINE_MS, BUNDLE_OBJECT_RETRY_AFTER_SECONDS } from './constants';
import { getBundleStub } from './dos/stubs';
import { readConfig, type Env, type StsConfig } from './env';
import type { GithubRun } from './identity/verify';
import { recordLeaseDenial, serveLease, serveLeaseRevoke, type LeaseCaller } from './leases/serve';
import { policyIndex } from './policy';
import type { PolicyIndex } from './policy/load';
import { callWithDeadline } from './rpc';
import { defaultMintAuthority, serveMint, type MintAuthority } from './tokens/mint';

export type SecretsBrokerProps = { caller: string };

/** Runs work after the response, as `ExecutionContext.waitUntil` does. */
export type WaitUntil = (promise: Promise<unknown>) => void;

type DeniedReason = BundleDenial['reason'];

const CallerPropsSchema = z.strictObject({ caller: WorkloadNameSchema });

/**
 * The in-account front door: a Worker binds this entrypoint with
 * `props: { caller: '<its own worker name>' }`, and STS authorizes on that value
 * against its policy files. Deploy-level trust, per design 6.4.
 */
export class SecretsBroker extends WorkerEntrypoint<Env, SecretsBrokerProps> {
  /**
   * The policies and scope registry a mint is checked against; a test fixture's subclass sets its
   * own. A static field, not a method: RPC exposes every prototype method of an entrypoint, and a
   * caller must not read the policy map through the binding.
   */
  static readonly mintAuthority: MintAuthority = defaultMintAuthority;

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

  /**
   * Service tokens for the caller named in props (design 6.1): one per requested audience, issued
   * or denied each by policy. One token-signer hop for the whole call.
   */
  async mintTokens(request: MintRequest): Promise<MintResult> {
    const config = readConfig(this.env);
    const props = CallerPropsSchema.safeParse(this.ctx.props);
    if (!props.success) {
      console.warn('sts: mint call refused: the binding carries no valid props.caller');
      return { status: 'identity_rejected' };
    }
    return await serveWorkerMint(
      this.env,
      config,
      props.data.caller,
      request,
      promise => this.ctx.waitUntil(promise),
      (this.constructor as typeof SecretsBroker).mintAuthority
    );
  }

  /**
   * A database lease for the caller named in props (design 6.1 job 3), checked against its own
   * policy's `dynamic` grants. The answer holds the role's password: keep it in memory only.
   */
  async lease(request: LeaseRequest): Promise<LeaseResult> {
    const policies = (this.constructor as typeof SecretsBroker).mintAuthority.policies;
    const waitUntil: WaitUntil = promise => this.ctx.waitUntil(promise);
    const entry = workerLeaseEntry(this.env, this.ctx.props, policies, waitUntil);
    if (entry.status === 'denied') return entry;
    const { config, caller } = entry;
    return await serveLease(this.env, config, { caller, request, policies, waitUntil });
  }

  /** Revokes one of the caller's own leases; any other lease id answers `not_found`. */
  async revokeLease(leaseId: string): Promise<LeaseRevokeResult> {
    const policies = (this.constructor as typeof SecretsBroker).mintAuthority.policies;
    const waitUntil: WaitUntil = promise => this.ctx.waitUntil(promise);
    const entry = workerLeaseEntry(this.env, this.ctx.props, policies, waitUntil);
    if (entry.status === 'denied') return entry;
    const { config, caller } = entry;
    return await serveLeaseRevoke(this.env, config, { caller, request: { leaseId }, waitUntil });
  }
}

/**
 * The props caller of a lease or revoke call, or why it is refused before its request is read
 * (audited, except a binding without valid props, which names no caller: a deploy error).
 */
function workerLeaseEntry(
  env: Env,
  props: unknown,
  policies: PolicyIndex,
  waitUntil: WaitUntil
):
  | { status: 'ok'; config: StsConfig; caller: LeaseCaller }
  | { status: 'denied'; reason: DeniedReason } {
  const config = readConfig(env);
  const parsed = CallerPropsSchema.safeParse(props);
  if (!parsed.success) {
    console.warn('sts: lease call refused: the binding carries no valid props.caller');
    return { status: 'denied', reason: 'identity_rejected' };
  }
  const caller: LeaseCaller = {
    workload: parsed.data.caller,
    identity: 'worker-binding',
    channel: 'worker-binding',
    run: null,
    claims: {},
  };
  const reason = workerRefusal(policies, config, caller.workload);
  if (reason !== null) {
    recordLeaseDenial(env, config, caller, waitUntil, reason);
    return { status: 'denied', reason };
  }
  return { status: 'ok', config, caller };
}

/**
 * A worker-binding caller mints under its own policy. A policy bound to another identity kind
 * refuses the whole call; a caller with no policy here gets every token denied `unknown_workload`.
 */
export async function serveWorkerMint(
  env: Env,
  config: StsConfig,
  caller: string,
  request: unknown,
  waitUntil: WaitUntil,
  authority: MintAuthority
): Promise<MintResult> {
  const policy = authority.policies.get(config.environment, caller);
  if (policy !== null && policy.identity.kind !== 'worker-binding') {
    const hop = recordDenial(env, config, {
      kind: 'token',
      channel: 'worker-binding',
      reason: 'identity_rejected',
      actor: caller,
      claims: {},
    });
    if (hop !== null) waitUntil(hop);
    return { status: 'identity_rejected' };
  }
  return await serveMint(env, config, {
    caller: {
      channel: 'worker-binding',
      workload: caller,
      identity: 'worker-binding',
      attestationExp: null,
      claims: {},
    },
    request,
    waitUntil,
    authority,
  });
}

/**
 * Why a Worker caller is refused before its request is read: no policy here (another
 * environment's, or none at all), or a policy bound to another identity kind.
 */
function workerRefusal(
  policies: PolicyIndex,
  config: StsConfig,
  caller: string
): DeniedReason | null {
  const policy = policies.get(config.environment, caller);
  if (policy === null) return policies.has(caller) ? 'environment_mismatch' : 'unknown_workload';
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
  const reason = workerRefusal(policyIndex, config, caller);
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
 * The hop is bounded by `BUNDLE_OBJECT_DEADLINE_MS` (`options.deadlineMs` overrides it), after
 * which STS answers `unavailable` (`callWithDeadline`). The bundle object finishes its own work,
 * so a fill still running stores the bundle and serves the next read. The trade-off: a delivery
 * the bundle object commits after the deadline is audited though the caller never got it, and the
 * caller's retry is audited again.
 */
export async function serveBundle(
  env: Env,
  config: StsConfig,
  workload: string,
  request: BundleRequest,
  options: { deadlineMs?: number; run?: GithubRun | null } = {}
): Promise<BundleResult> {
  const parsed = BundleRequestSchema.parse(request);
  const outcome = await callWithDeadline(
    async () =>
      await getBundleStub(env, config, workload).getBundle(
        workload,
        config.environment,
        parsed,
        options.run ?? null
      ),
    options.deadlineMs ?? BUNDLE_OBJECT_DEADLINE_MS
  );
  if (outcome.status === 'answered') return outcome.value;
  if (outcome.status === 'failed') {
    console.error('sts: bundle object call failed', {
      workload,
      reason: outcome.error instanceof Error ? outcome.error.name : 'unknown',
    });
  } else {
    console.error('sts: bundle object did not answer before the deadline', { workload });
  }
  return {
    status: 'unavailable',
    reason: 'internal',
    retryAfterSeconds: BUNDLE_OBJECT_RETRY_AFTER_SECONDS,
  };
}
