import {
  MintRequestSchema,
  STS_SCOPE_REGISTRY,
  isRegisteredStsScope,
  type IssuedToken,
  type MintDeniedReason,
  type MintEntryResult,
  type MintResult,
  type StsScopeRegistry,
} from '@kilocode/sts-contracts';
import { DENIAL_FIELD_MAX_LENGTH, recordDenial, type TokenDenial } from '../audit/denials';
import {
  MIN_TOKEN_LIFETIME_SECONDS,
  TOKEN_SIGNER_DEADLINE_MS,
  TOKEN_SIGNER_RETRY_AFTER_SECONDS,
} from '../constants';
import { getTokenSignerStub, pickTokenSignerShard } from '../dos/stubs';
import type { Env, StsConfig } from '../env';
import { policyIndex } from '../policy';
import type { PolicyIndex } from '../policy/load';
import { callWithDeadline } from '../rpc';

/** What a mint is checked against: the policy files and the scope registry. */
export type MintAuthority = { policies: PolicyIndex; scopes: StsScopeRegistry };

export const defaultMintAuthority: MintAuthority = {
  policies: policyIndex,
  scopes: STS_SCOPE_REGISTRY,
};

/** An identified caller: a Worker binding's props, or a provider token that verified. */
export type MintCaller = {
  channel: TokenDenial['channel'];
  /** The policy workload; for a verified token that maps to none, the provider's stable id. */
  workload: string;
  /** `worker-binding`, or the provider the token came from. */
  identity: string;
  /** The attestation's `exp` in seconds; null for a worker binding, which has none. */
  attestationExp: number | null;
  /** Stable claims for a denial row (the provider, never the token). */
  claims: Record<string, string>;
};

type Decision = { audience: string; scope: string; reason: MintDeniedReason | null };

/**
 * Per-token policy decision, in this order: a workload with no policy in this environment, a scope
 * the registry does not list, an audience or a scope the policy does not grant (design 6.3:
 * default deny).
 */
function decide(
  authority: MintAuthority,
  environment: StsConfig['environment'],
  workload: string,
  entry: { audience: string; scope: string }
): MintDeniedReason | null {
  const policy = authority.policies.get(environment, workload);
  if (policy === null) return 'unknown_workload';
  if (!isRegisteredStsScope(entry.audience, entry.scope, authority.scopes)) return 'unknown_scope';
  if (!policy.audiences.includes(entry.audience)) return 'audience_not_allowed';
  if (!policy.scopes.includes(entry.scope)) return 'scope_not_allowed';
  return null;
}

/**
 * Mints service tokens for an identified caller: validates the request, decides each token by
 * policy, then signs every allowed token in one token-signer hop that also appends the one audit
 * row of the call. Each refused token is recorded as an `ai.kilo.sts.token.denied` denial, all of
 * them in one denial-object hop after the response. The signer hop is not retried (a retry after
 * a committed append would audit tokens the caller never got) and is bounded by
 * `TOKEN_SIGNER_DEADLINE_MS`; a failed or late hop answers `unavailable` and returns no token.
 */
export async function serveMint(
  env: Env,
  config: StsConfig,
  input: {
    caller: MintCaller;
    request: unknown;
    waitUntil: (promise: Promise<unknown>) => void;
    authority: MintAuthority;
  }
): Promise<MintResult> {
  const { caller, waitUntil, authority } = input;
  const parsed = MintRequestSchema.safeParse(input.request);
  if (!parsed.success) return { status: 'invalid_request' };
  // Longer than a denial row holds; no policy grants one that long. Refused whole, before any
  // denial is recorded.
  const oversized = parsed.data.tokens.some(
    ({ audience, scope }) =>
      audience.length > DENIAL_FIELD_MAX_LENGTH || scope.length > DENIAL_FIELD_MAX_LENGTH
  );
  if (oversized) return { status: 'invalid_request' };

  const expiring =
    caller.attestationExp !== null &&
    caller.attestationExp - Math.floor(Date.now() / 1000) < MIN_TOKEN_LIFETIME_SECONDS;
  const decisions: Decision[] = parsed.data.tokens.map(entry => {
    const reason = decide(authority, config.environment, caller.workload, entry);
    return { ...entry, reason: reason ?? (expiring ? 'attestation_expiring' : null) };
  });
  const allowed = decisions.filter(decision => decision.reason === null);

  let signed = new Map<string, IssuedToken>();
  if (allowed.length > 0) {
    const outcome = await callWithDeadline(
      async () =>
        await getTokenSignerStub(env, config, pickTokenSignerShard()).mint({
          environment: config.environment,
          workload: caller.workload,
          identity: caller.identity,
          attestationExp: caller.attestationExp,
          request: { tokens: allowed.map(({ audience, scope }) => ({ audience, scope })) },
        }),
      TOKEN_SIGNER_DEADLINE_MS
    );
    if (outcome.status !== 'answered' || outcome.value.status === 'unavailable') {
      console.error('sts: token signer call failed; no token is returned', {
        workload: caller.workload,
        outcome: outcome.status === 'answered' ? 'unavailable' : outcome.status,
        reason:
          outcome.status === 'failed' && outcome.error instanceof Error
            ? outcome.error.name
            : 'none',
      });
      recordRefusals(env, config, caller, decisions, waitUntil);
      return { status: 'unavailable', retryAfterSeconds: TOKEN_SIGNER_RETRY_AFTER_SECONDS };
    }
    if (outcome.value.status === 'attestation_expiring') {
      for (const decision of allowed) decision.reason = 'attestation_expiring';
    } else {
      signed = new Map(outcome.value.tokens.map(token => [token.audience, { ...token }]));
    }
  }

  recordRefusals(env, config, caller, decisions, waitUntil);
  const tokens: MintEntryResult[] = [];
  for (const decision of decisions) {
    const { audience, scope, reason } = decision;
    if (reason !== null) {
      tokens.push({ status: 'denied', audience, scope, reason });
      continue;
    }
    const issued = signed.get(audience);
    // The signer answers one token per allowed entry; anything else returns no token at all.
    if (issued === undefined) {
      console.error('sts: token signer answered without a requested token', { audience });
      return { status: 'unavailable', retryAfterSeconds: TOKEN_SIGNER_RETRY_AFTER_SECONDS };
    }
    tokens.push(issued);
  }
  return { status: 'ok', tokens };
}

function recordRefusals(
  env: Env,
  config: StsConfig,
  caller: MintCaller,
  decisions: Decision[],
  waitUntil: (promise: Promise<unknown>) => void
): void {
  const denials: TokenDenial[] = decisions.flatMap(decision =>
    decision.reason === null
      ? []
      : [
          {
            kind: 'token',
            channel: caller.channel,
            reason: decision.reason,
            actor: caller.workload,
            audience: decision.audience,
            scope: decision.scope,
            claims: caller.claims,
          },
        ]
  );
  if (denials.length === 0) return;
  const hop = recordDenial(env, config, ...denials);
  if (hop !== null) waitUntil(hop);
}
