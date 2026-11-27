import {
  LeaseRequestSchema,
  LeaseRevokeRequestSchema,
  type LeaseGrant,
  type LeaseResult,
  type LeaseRevokeResult,
} from '@kilocode/sts-contracts';
import { recordDenial, type LeaseDenialReason } from '../audit/denials';
import type { LeaseAuditCaller } from '../audit/events';
import { LEASE_OBJECT_DEADLINE_MS, LEASE_RETRY_AFTER_SECONDS } from '../constants';
import { getLeaseStub } from '../dos/stubs';
import type { Env, StsConfig } from '../env';
import type { PolicyIndex } from '../policy/load';
import { leaseDynamicGrant } from '../policy/schema';
import { callWithDeadline } from '../rpc';

/** An identified lease caller: the audit fields, plus the stable claims its denial rows carry. */
export type LeaseCaller = LeaseAuditCaller & { claims: Record<string, string> };

type WaitUntil = (promise: Promise<unknown>) => void;

const UNAVAILABLE = {
  status: 'unavailable',
  retryAfterSeconds: LEASE_RETRY_AFTER_SECONDS,
} as const;

/** Audits a refused lease or revoke after the response (one denial-object hop at most). */
export function recordLeaseDenial(
  env: Env,
  config: StsConfig,
  caller: Pick<LeaseCaller, 'channel' | 'workload' | 'claims'>,
  waitUntil: WaitUntil,
  reason: LeaseDenialReason,
  detail: { grant?: LeaseGrant; leaseId?: string } = {}
): void {
  const hop = recordDenial(env, config, {
    kind: 'lease',
    channel: caller.channel,
    reason,
    actor: caller.workload,
    claims: caller.claims,
    ...detail,
  });
  if (hop !== null) waitUntil(hop);
}

function auditCaller(caller: LeaseCaller): LeaseAuditCaller {
  return {
    workload: caller.workload,
    identity: caller.identity,
    channel: caller.channel,
    run: caller.run,
  };
}

/**
 * A lease for an identified caller (design 6.1 job 3): the policy must list the grant (default
 * deny); the lifetime is the request's, or the policy default, shortened to the policy maximum.
 * Then one lease-object hop, bounded by `LEASE_OBJECT_DEADLINE_MS` and never retried (a creation
 * has a side effect at the database), which enforces the workload's limits, creates the lease and
 * commits its audit row.
 */
export async function serveLease(
  env: Env,
  config: StsConfig,
  input: { caller: LeaseCaller; request: unknown; policies: PolicyIndex; waitUntil: WaitUntil }
): Promise<LeaseResult> {
  const { caller, waitUntil } = input;
  const parsed = LeaseRequestSchema.safeParse(input.request);
  if (!parsed.success) return { status: 'invalid_request' };
  const { grant } = parsed.data;
  const policy = input.policies.get(config.environment, caller.workload);
  const entry = policy === null ? undefined : leaseDynamicGrant(policy, grant);
  if (entry === undefined) {
    const reason = policy === null ? 'unknown_workload' : 'grant_not_allowed';
    recordLeaseDenial(env, config, caller, waitUntil, reason, { grant });
    return { status: 'denied', reason };
  }

  const requestedTtlSeconds = parsed.data.ttlSeconds ?? null;
  const wanted = requestedTtlSeconds ?? entry.defaultTtlSeconds;
  const ttlSeconds = Math.min(wanted, entry.maxTtlSeconds);
  const clamped = wanted > entry.maxTtlSeconds;
  const requestedAt = Date.now();
  const outcome = await callWithDeadline(
    async () =>
      await getLeaseStub(env, config).create({
        environment: config.environment,
        caller: auditCaller(caller),
        grant,
        ttlSeconds,
        requestedTtlSeconds,
        clamped,
        maxActive: entry.maxActive,
        requestedAt,
      }),
    LEASE_OBJECT_DEADLINE_MS
  );
  if (outcome.status !== 'answered') {
    console.error('sts: lease object call failed; no lease is returned', {
      workload: caller.workload,
      grant,
      outcome: outcome.status,
      reason:
        outcome.status === 'failed' && outcome.error instanceof Error ? outcome.error.name : 'none',
    });
    return UNAVAILABLE;
  }
  const result = outcome.value;
  if (result.status === 'unavailable') return result;
  if (result.status === 'limited') {
    recordLeaseDenial(env, config, caller, waitUntil, result.reason, { grant });
    return result;
  }
  return {
    status: 'ok',
    leaseId: result.leaseId,
    grant,
    username: result.username,
    password: result.password,
    expiresAt: new Date(result.expiresAt).toISOString(),
    ttlSeconds,
    clamped,
  };
}

/**
 * Revokes one of the caller's own leases through the lease object, which knows each lease's
 * workload. Another workload's lease and an unknown id both answer `not_found`, and each is
 * audited as a lease denial with the reason the object found.
 */
export async function serveLeaseRevoke(
  env: Env,
  config: StsConfig,
  input: { caller: LeaseCaller; request: unknown; waitUntil: WaitUntil }
): Promise<LeaseRevokeResult> {
  const { caller, waitUntil } = input;
  const parsed = LeaseRevokeRequestSchema.safeParse(input.request);
  if (!parsed.success) return { status: 'invalid_request' };
  const { leaseId } = parsed.data;
  const outcome = await callWithDeadline(
    async () =>
      await getLeaseStub(env, config).revoke({
        environment: config.environment,
        caller: auditCaller(caller),
        leaseId,
      }),
    LEASE_OBJECT_DEADLINE_MS
  );
  if (outcome.status !== 'answered') {
    console.error('sts: lease object revoke call failed', {
      workload: caller.workload,
      outcome: outcome.status,
      reason:
        outcome.status === 'failed' && outcome.error instanceof Error ? outcome.error.name : 'none',
    });
    return UNAVAILABLE;
  }
  const result = outcome.value;
  if (result.status === 'unavailable') return result;
  if (result.status === 'not_found') {
    recordLeaseDenial(env, config, caller, waitUntil, result.reason, { leaseId });
    return { status: 'not_found' };
  }
  return { status: 'revoked', leaseId };
}
