import {
  CloudflareDeployTokenRequestSchema,
  CloudflareDeployTokenRevokeRequestSchema,
  type CloudflareDeployTokenResult,
  type CloudflareDeployTokenRevokeResult,
} from '@kilocode/sts-contracts';
import { recordDenial, type DeployTokenDenialReason } from '../audit/denials';
import type { DeployTokenAuditCaller } from '../audit/events';
import { DEPLOY_TOKEN_OBJECT_DEADLINE_MS, DEPLOY_TOKEN_RETRY_AFTER_SECONDS } from '../constants';
import { getDeployTokenStub } from '../dos/stubs';
import type { Env, StsConfig } from '../env';
import type { GithubRun } from '../identity/verify';
import type { PolicyIndex } from '../policy/load';
import { cloudflareDeployGrant } from '../policy/schema';
import { callWithDeadline } from '../rpc';

/**
 * A verified HTTP caller of the deploy-token routes: the audit fields, plus the stable claims its
 * denial rows carry. `run` is null for a provider token that names no GitHub run.
 */
export type DeployTokenCaller = {
  workload: string;
  identity: string;
  run: GithubRun | null;
  claims: Record<string, string>;
};

type WaitUntil = (promise: Promise<unknown>) => void;

const UNAVAILABLE = {
  status: 'unavailable',
  retryAfterSeconds: DEPLOY_TOKEN_RETRY_AFTER_SECONDS,
} as const;

/** Audits a refused deploy token or revoke after the response (one denial-object hop at most). */
export function recordDeployTokenDenial(
  env: Env,
  config: StsConfig,
  caller: Pick<DeployTokenCaller, 'workload' | 'claims'>,
  waitUntil: WaitUntil,
  reason: DeployTokenDenialReason,
  tokenId?: string
): void {
  const hop = recordDenial(env, config, {
    kind: 'deploy_token',
    channel: 'http',
    reason,
    actor: caller.workload,
    claims: caller.claims,
    ...(tokenId === undefined ? {} : { tokenId }),
  });
  if (hop !== null) waitUntil(hop);
}

/** The audit caller of a GitHub job; null for any other verified caller. */
function githubCaller(caller: DeployTokenCaller): DeployTokenAuditCaller | null {
  if (caller.identity !== 'github' || caller.run === null) return null;
  return { workload: caller.workload, identity: 'github', channel: 'http', run: caller.run };
}

/**
 * A Cloudflare deploy token for a verified GitHub job (design 4.4, 4.5, 6.1 job 3): the policy must
 * list a `cloudflare-deploy` grant (default deny; the loader admits one only on a GitHub policy
 * bound to a protected environment, and a production one only on `refs/heads/main`). Then one
 * deploy-token object hop, bounded by `DEPLOY_TOKEN_OBJECT_DEADLINE_MS` and never retried (a
 * creation has a side effect at Cloudflare), which enforces the workload's limits, mints the
 * token and commits its audit row.
 */
export async function serveDeployToken(
  env: Env,
  config: StsConfig,
  input: {
    caller: DeployTokenCaller;
    request: unknown;
    policies: PolicyIndex;
    waitUntil: WaitUntil;
  }
): Promise<CloudflareDeployTokenResult> {
  const { caller, waitUntil } = input;
  if (!CloudflareDeployTokenRequestSchema.safeParse(input.request).success) {
    return { status: 'invalid_request' };
  }
  const policy = input.policies.get(config.environment, caller.workload);
  const grant = policy === null ? undefined : cloudflareDeployGrant(policy);
  if (grant === undefined) {
    const reason = policy === null ? 'unknown_workload' : 'grant_not_allowed';
    recordDeployTokenDenial(env, config, caller, waitUntil, reason);
    return { status: 'denied', reason };
  }
  // The loader admits the grant on GitHub policies only; a token without a run cannot own one.
  const auditCaller = githubCaller(caller);
  if (auditCaller === null) {
    recordDeployTokenDenial(env, config, caller, waitUntil, 'identity_rejected');
    return { status: 'denied', reason: 'identity_rejected' };
  }

  const requestedAt = Date.now();
  const outcome = await callWithDeadline(
    async () =>
      await getDeployTokenStub(env, config).mint({
        environment: config.environment,
        caller: auditCaller,
        grant,
        requestedAt,
      }),
    DEPLOY_TOKEN_OBJECT_DEADLINE_MS
  );
  if (outcome.status !== 'answered') {
    console.error('sts: deploy-token object call failed; no token is returned', {
      workload: caller.workload,
      outcome: outcome.status,
      reason:
        outcome.status === 'failed' && outcome.error instanceof Error ? outcome.error.name : 'none',
    });
    return UNAVAILABLE;
  }
  const result = outcome.value;
  if (result.status === 'unavailable') return result;
  if (result.status === 'limited') {
    recordDeployTokenDenial(env, config, caller, waitUntil, result.reason);
    return result;
  }
  return {
    status: 'ok',
    token: result.token,
    tokenId: result.tokenId,
    expiresAt: new Date(result.expiresAt).toISOString(),
    ttlSeconds: result.ttlSeconds,
    permissionSet: grant.permissionSet,
  };
}

/**
 * Deletes one of the caller's own deploy tokens through the deploy-token object, which knows each
 * token's workload and run. Another workload's token, another run's token and an unknown id all
 * answer `not_found`, and each is audited as a deploy-token denial with the reason the object
 * found. A caller that is not a GitHub job holds no deploy token, so its every revoke is
 * `not_found` too.
 */
export async function serveDeployTokenRevoke(
  env: Env,
  config: StsConfig,
  input: { caller: DeployTokenCaller; request: unknown; waitUntil: WaitUntil }
): Promise<CloudflareDeployTokenRevokeResult> {
  const { caller, waitUntil } = input;
  const parsed = CloudflareDeployTokenRevokeRequestSchema.safeParse(input.request);
  if (!parsed.success) return { status: 'invalid_request' };
  const { tokenId } = parsed.data;
  const auditCaller = githubCaller(caller);
  if (auditCaller === null) {
    recordDeployTokenDenial(env, config, caller, waitUntil, 'not_owner', tokenId);
    return { status: 'not_found' };
  }
  const outcome = await callWithDeadline(
    async () =>
      await getDeployTokenStub(env, config).revoke({
        environment: config.environment,
        caller: auditCaller,
        tokenId,
      }),
    DEPLOY_TOKEN_OBJECT_DEADLINE_MS
  );
  if (outcome.status !== 'answered') {
    console.error('sts: deploy-token object revoke call failed', {
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
    recordDeployTokenDenial(env, config, caller, waitUntil, result.reason, tokenId);
    return { status: 'not_found' };
  }
  return { status: 'revoked', tokenId };
}
