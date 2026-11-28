import {
  type CiTokenResponse,
  GITHUB_ACTIONS_ISSUER,
  UTS_ACCESS_TOKEN_TYPE_URN,
  UtsAccessTokenClaimsSchema,
  audienceOfResource,
  audienceOfScope,
} from '@kilocode/uts-contracts';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { z } from 'zod';
import type { UtsConfig } from '../env';
import {
  classifyFailure,
  failureResponse,
  oauthError,
  temporarilyUnavailable,
} from '../oauth/errors';
import type { Params } from '../oauth/params';
import { jsonResponse } from '../responses';
import type { ScopeRegistry } from '../scopes/policy';
import type { SignerAccess } from '../token/mint';
import type { GithubKeys } from './github-keys';
import { type CiPolicy, ciLegacySubject, ciSubject } from './policy';
import type { CiExchangeInput, CiRun, CiTokenAccess } from './store';

/**
 * The CI token exchange at `POST /token` (design 5.3, 5.5, 6.2; RFC 8693): a request whose
 * `subject_token_type` is the ID-token type. Wire contract in `@kilocode/uts-contracts`, `ci.ts`.
 *
 * Steps, each refusing before the next costs anything:
 * 1. the switch: without policies the exchange is not offered (`unsupported_grant_type`);
 * 2. the form: the subject token once, exactly one `scope` and one `resource`, the requested type
 *    absent or the access-token type, no actor token, `audience` or `client_id`
 *    (`invalid_request`); a registered scope (`invalid_scope`) and the exact resource of its
 *    audience (`invalid_target`);
 * 3. the OIDC token: `RS256` under a key of GitHub's key set (src/ci/github-keys.ts; `unavailable`
 *    answers 503), GitHub's issuer, exactly the UTS issuer URL as its one audience, `exp` with 60
 *    seconds of skew, an `iat` not in the future, and the claims the policies bind
 *    (`invalid_grant`);
 * 4. the policy: the repository and owner ids, then the GitHub environment and the workflow entry
 *    select at most one policy (none: `invalid_grant`, no statement); that policy's subject, ref,
 *    event and the entry's pin to the token's own ref must match (`invalid_grant`), and it must
 *    grant the scope (`invalid_scope`). Those two refusals write a denied audit row, at most one
 *    per policy and reason per minute in each isolate;
 * 5. one SQL statement (src/ci/store.ts): the account is active, and the issued audit row;
 * 6. one signer call for the one token, signed in the object its `jti` picks.
 *
 * The token carries `sub` (the policy's account), `client_id` (the policy's name), `scope`, `aud`,
 * `env` and the policy's lifetime of at most 1 hour; no `sid`, `org`, `act` or refresh token. A
 * job that needs a later token exchanges a fresh OIDC token. Retry only on 503, after
 * `Retry-After`.
 */

const SKEW_SECONDS = 60;
const DENIED_AUDIT_INTERVAL_MS = 60_000;
const FORBIDDEN_PARAMS = ['actor_token', 'actor_token_type', 'audience', 'client_id'] as const;

/**
 * The CI exchange as the environment configures it: `off` without policies; `misconfigured` when
 * the policy var breaks a rule, which keeps it off and logs the problems on each CI request.
 */
export type CiExchangeService =
  | { status: 'off' }
  | { status: 'misconfigured'; problems: readonly string[] }
  | {
      status: 'on';
      policies: readonly CiPolicy[];
      keys: GithubKeys;
      store: CiTokenAccess;
      /** Per isolate: when each `<policy> <reason>` denial row was last written. */
      deniedAudits: Map<string, number>;
      now: () => number;
    };

export type CiExchangeDeps = {
  config: UtsConfig;
  sign: SignerAccess;
  scopes: ScopeRegistry;
  ci: CiExchangeService;
};

const Bounded = z.string().min(1).max(255);
const Digits = z.string().regex(/^[0-9]{1,20}$/);

/** The claims of a GitHub Actions OIDC token that the policies bind and the audit row records. */
const GithubClaimsSchema = z.object({
  sub: z.string().min(1).max(512),
  repository_id: Digits,
  repository_owner_id: Digits,
  environment: Bounded,
  ref: z.string().min(1).max(255),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  event_name: z.string().regex(/^[a-z_]{1,64}$/),
  job_workflow_ref: z.string().min(1).max(512),
  run_id: Digits,
  run_attempt: Digits,
  jti: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});
type GithubClaims = z.infer<typeof GithubClaimsSchema>;

type TokenCheck =
  | { status: 'ok'; claims: GithubClaims }
  | { status: 'invalid' }
  | { status: 'unavailable' };

function refused(reason: string, policy: string | null): void {
  console.warn(JSON.stringify({ event: 'uts.ci_token.refused', reason, policy }));
}

function invalidGrant(): Response {
  return oauthError('invalid_grant', 400, 'the subject token is invalid, expired or not trusted');
}

function one(params: Params, name: string): string | null {
  const param = params.one(name);
  return param.status === 'present' ? param.value : null;
}

/** Step 3: the OIDC token's signature, issuer, audience, times and bound claims. */
async function verifyGithubToken(
  token: string,
  keys: GithubKeys,
  audience: string,
  nowSeconds: number
): Promise<TokenCheck> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { status: 'invalid' };
  }
  const kid = z.string().min(1).max(256).safeParse(header.kid);
  if (header.alg !== 'RS256' || !kid.success) return { status: 'invalid' };
  const found = await keys(kid.data);
  if (found.status === 'unavailable') return { status: 'unavailable' };
  if (found.status === 'unknown') return { status: 'invalid' };
  let payload;
  try {
    const verified = await jwtVerify(token, await importJWK(found.key, 'RS256'), {
      algorithms: ['RS256'],
      issuer: GITHUB_ACTIONS_ISSUER,
      audience,
      clockTolerance: SKEW_SECONDS,
      currentDate: new Date(nowSeconds * 1000),
      requiredClaims: ['exp', 'iat'],
    });
    payload = verified.payload;
  } catch {
    return { status: 'invalid' };
  }
  // jose accepts an audience list that contains the UTS issuer; a token for UTS names it alone.
  if (payload.aud !== audience) return { status: 'invalid' };
  const claims = GithubClaimsSchema.safeParse(payload);
  if (!claims.success || claims.data.iat > nowSeconds + SKEW_SECONDS) return { status: 'invalid' };
  return { status: 'ok', claims: claims.data };
}

/** Step 4: the bindings of the one policy the token's environment and workflow entry selected. */
function meetsBindings(claims: GithubClaims, policy: CiPolicy): boolean {
  return (
    policy.refs.includes(claims.ref) &&
    claims.job_workflow_ref.endsWith(`@${claims.ref}`) &&
    policy.events.some(event => event === claims.event_name) &&
    (claims.sub === ciSubject(policy) ||
      (policy.legacySubject === true && claims.sub === ciLegacySubject(policy)))
  );
}

function runOf(claims: GithubClaims): CiRun {
  return {
    repositoryId: claims.repository_id,
    githubEnvironment: claims.environment,
    ref: claims.ref,
    sha: claims.sha,
    eventName: claims.event_name,
    jobWorkflowRef: claims.job_workflow_ref,
    runId: claims.run_id,
    runAttempt: claims.run_attempt,
    subjectTokenId: claims.jti,
  };
}

/**
 * Writes the denied row of a refusal at most once per policy and reason per minute in this
 * isolate. The slot is taken before the statement runs, so concurrent refusals write one row. A
 * failed write is logged; the refusal answers as it would have.
 */
async function auditRefusal(
  ci: Extract<CiExchangeService, { status: 'on' }>,
  input: CiExchangeInput
): Promise<void> {
  const key = `${input.policy} ${input.refusal}`;
  const now = ci.now();
  const last = ci.deniedAudits.get(key);
  if (last !== undefined && now - last < DENIED_AUDIT_INTERVAL_MS) return;
  ci.deniedAudits.set(key, now);
  try {
    await ci.store(store => store.exchange(input));
  } catch (error) {
    classifyFailure(error, 'ci_token_refusal');
  }
}

export async function handleCiTokenExchange(
  params: Params,
  deps: CiExchangeDeps
): Promise<Response> {
  const { ci, config } = deps;

  // 1. The switch.
  if (ci.status === 'misconfigured') {
    console.error(JSON.stringify({ event: 'uts.ci_token.misconfigured', problems: ci.problems }));
  }
  if (ci.status !== 'on') return oauthError('unsupported_grant_type', 400);

  // 2. The form.
  const subjectToken = one(params, 'subject_token');
  const requestedType = params.one('requested_token_type');
  const resource = one(params, 'resource');
  const scope = one(params, 'scope');
  if (
    subjectToken === null ||
    requestedType.status === 'repeated' ||
    (requestedType.status === 'present' && requestedType.value !== UTS_ACCESS_TOKEN_TYPE_URN) ||
    resource === null ||
    scope === null ||
    FORBIDDEN_PARAMS.some(name => params.one(name).status !== 'absent')
  ) {
    return oauthError(
      'invalid_request',
      400,
      'subject_token, resource and scope are required once; no client or actor credentials'
    );
  }
  if (deps.scopes(scope) === null) {
    return oauthError('invalid_scope', 400, 'the scope is not registered');
  }
  if (audienceOfResource(resource, config.environment) !== audienceOfScope(scope)) {
    return oauthError('invalid_target', 400, 'resource must name the service of the scope');
  }

  // 3. The OIDC token.
  const nowSeconds = Math.floor(ci.now() / 1000);
  const checked = await verifyGithubToken(
    subjectToken,
    ci.keys,
    config.endpoints.issuer,
    nowSeconds
  );
  if (checked.status === 'unavailable') return temporarilyUnavailable();
  if (checked.status === 'invalid') {
    refused('token_invalid', null);
    return invalidGrant();
  }
  const { claims } = checked;

  // 4. The policy. The loader admits one policy per repository, GitHub environment and workflow
  // file, so at most one policy passes the selection.
  const policy = ci.policies.find(
    candidate =>
      candidate.repositoryId === claims.repository_id &&
      candidate.repositoryOwnerId === claims.repository_owner_id &&
      candidate.environment === claims.environment &&
      candidate.jobWorkflowRefs.includes(claims.job_workflow_ref)
  );
  if (policy === undefined) {
    refused('no_policy', null);
    return invalidGrant();
  }
  const input: CiExchangeInput = {
    environment: config.environment,
    policy: policy.name,
    accountId: policy.subject,
    scope,
    lifetimeSeconds: policy.lifetimeSeconds,
    run: runOf(claims),
    refusal: null,
  };
  if (!meetsBindings(claims, policy)) {
    refused('binding_mismatch', policy.name);
    await auditRefusal(ci, { ...input, refusal: 'binding_mismatch' });
    return invalidGrant();
  }
  if (!policy.scopes.includes(scope)) {
    refused('scope_not_granted', policy.name);
    await auditRefusal(ci, { ...input, refusal: 'scope_not_granted' });
    return oauthError('invalid_scope', 400, 'the trust policy does not grant this scope');
  }

  // 5. The statement.
  let stored;
  try {
    stored = await ci.store(store => store.exchange(input));
  } catch (error) {
    return failureResponse(error, 'ci_token');
  }
  if (stored.outcome !== 'issued') {
    refused(stored.outcome, policy.name);
    return invalidGrant();
  }

  // 6. The signer call.
  const claimsOut = UtsAccessTokenClaimsSchema.parse({
    iss: config.endpoints.issuer,
    exp: nowSeconds + policy.lifetimeSeconds,
    aud: audienceOfScope(scope),
    sub: policy.subject,
    client_id: policy.name,
    iat: nowSeconds,
    jti: stored.tokenId,
    scope,
    env: config.environment,
  });
  const signed = await deps.sign(stored.tokenId, [claimsOut]);
  if (signed.status === 'unavailable') return temporarilyUnavailable();
  if (signed.status === 'misconfigured') return oauthError('server_error', 500);
  const body: CiTokenResponse = {
    access_token: signed.tokens[0],
    issued_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
    token_type: 'Bearer',
    expires_in: policy.lifetimeSeconds,
    scope,
  };
  return jsonResponse(body, 200, { Pragma: 'no-cache' });
}
