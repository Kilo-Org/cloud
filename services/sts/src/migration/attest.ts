import {
  GithubRunAttestationRequestSchema,
  MIGRATION_PROXY_WORKLOAD,
  type GithubRunAttestationDeniedReason,
  type GithubRunAttestationResult,
} from '@kilocode/sts-contracts';
import { recordDenial } from '../audit/denials';
import { VERIFIER_RETRY_AFTER_SECONDS } from '../constants';
import type { Env, StsConfig } from '../env';
import { IdentityVerifier } from '../identity/verify';
import type { PolicyIndex } from '../policy/load';
import { holdsMigrationRun } from '../policy/schema';

type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * One verifier per isolate for the proxy's audience, apart from the routes' verifier: provider
 * discovery and key sets are cached in it. Plain data only, never a promise (see `http.ts`).
 */
let verifierCache: { key: string; policies: PolicyIndex; instance: IdentityVerifier } | null = null;

function attestationVerifier(
  config: StsConfig,
  audience: string,
  policies: PolicyIndex
): IdentityVerifier {
  const key = `${audience}|${config.environment}`;
  const cached = verifierCache;
  if (cached !== null && cached.key === key && cached.policies === policies) {
    return cached.instance;
  }
  // Every policy, so a token of another workflow names its own policy and is refused
  // `grant_not_allowed` rather than `unknown_workload`.
  const instance = new IdentityVerifier({
    policies: policies.all(),
    environment: config.environment,
    audience,
    githubClaims: true,
    fetch: (input, init) => fetch(input, init),
  });
  verifierCache = { key, policies, instance };
  return instance;
}

function denied(reason: GithubRunAttestationDeniedReason): GithubRunAttestationResult {
  return { status: 'denied', reason };
}

/**
 * `SecretsBroker.attestGithubRun` (README "Migration run attestation"): only the props caller
 * `migration-proxy` may ask. STS verifies the GitHub job's token as `/v1/bundle` does, but with
 * `MIGRATION_PROXY_AUDIENCE` (empty refuses every attestation), requires the matched policy's
 * `migration-run` grant, and returns the verified claims. An attestation STS gives writes no row;
 * a refusal from an identified caller is recorded as a denial on channel `migration-attest`.
 */
export async function serveAttestGithubRun(
  env: Env,
  config: StsConfig,
  input: { caller: string | null; request: unknown; policies: PolicyIndex; waitUntil: WaitUntil }
): Promise<GithubRunAttestationResult> {
  const { policies, waitUntil } = input;
  const record = (
    reason: GithubRunAttestationDeniedReason,
    actor: string,
    claims: Record<string, string>
  ): GithubRunAttestationResult => {
    const hop = recordDenial(env, config, {
      kind: 'migration_attest',
      channel: 'migration-attest',
      reason,
      actor,
      claims,
    });
    if (hop !== null) waitUntil(hop);
    return denied(reason);
  };

  if (input.caller === null) {
    // No caller name to audit: a binding without valid props is a deploy error.
    console.warn('sts: attestation refused: the binding carries no valid props.caller');
    return denied('caller_not_allowed');
  }
  if (input.caller !== MIGRATION_PROXY_WORKLOAD) {
    return record('caller_not_allowed', input.caller, {});
  }

  const request = GithubRunAttestationRequestSchema.safeParse(input.request);
  if (!request.success) return denied('identity_rejected');
  const audience = config.migrationProxyAudience;
  if (audience === null) {
    console.warn('sts: attestation refused: MIGRATION_PROXY_AUDIENCE is empty here');
    return denied('identity_rejected');
  }

  const outcome = await attestationVerifier(config, audience, policies).verify(request.data.token);
  if (outcome.status === 'unavailable') {
    return { status: 'unavailable', retryAfterSeconds: VERIFIER_RETRY_AFTER_SECONDS };
  }
  if (outcome.status === 'denied') {
    const { subject } = outcome;
    if (subject === undefined) {
      console.warn('sts: attestation refused: token not verified', {
        environment: config.environment,
        reason: outcome.reason,
      });
      return denied(outcome.reason);
    }
    return record(outcome.reason, subject.actor, { provider: subject.provider, ...subject.claims });
  }

  const policy = policies.get(config.environment, outcome.workload);
  if (policy === null || !holdsMigrationRun(policy)) {
    return record('grant_not_allowed', outcome.workload, { provider: outcome.provider });
  }
  if (outcome.github === null) {
    // The policy's bindings passed, so only a missing `sha` or run claim lands here.
    return record('identity_rejected', outcome.workload, { provider: outcome.provider });
  }
  return {
    status: 'ok',
    workload: outcome.workload,
    github: outcome.github,
    expiresAt: new Date(outcome.attestationExp * 1000).toISOString(),
  };
}
