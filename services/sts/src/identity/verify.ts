import type { StsEnvironment, WorkloadName } from '@kilocode/sts-contracts';
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTPayload,
  type RemoteJWKSet,
} from 'jose';
import { z } from 'zod';
import { PROVIDER_FETCH_TIMEOUT_MS } from '../constants';
import {
  GITHUB_PRIVILEGED_EVENTS,
  VERCEL_ISSUER_PREFIX,
  vercelStsEnvironments,
  type Policy,
  type PolicyIdentity,
  type VercelEnvironment,
} from '../policy/schema';

const DiscoverySchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.url(),
});

export type IdentityProvider = 'fly' | 'github' | 'vercel';
export type DeniedReason = 'identity_rejected' | 'unknown_workload' | 'environment_mismatch';

/**
 * Who a refused token came from, set only after its signature, issuer, audience and lifetime
 * verified. `actor` is the policy's workload when the token named one, otherwise the provider's
 * stable id; `claims` are the provider's stable ids, never the token.
 */
export type VerifiedSubject = {
  provider: IdentityProvider;
  actor: string;
  claims: Record<string, string>;
};

export type VerifyOutcome =
  | {
      status: 'verified';
      workload: WorkloadName;
      provider: IdentityProvider;
      /** The provider token's own `exp` and `iat`, in seconds; a minted token never outlives it. */
      attestationExp: number;
      attestationIat: number;
    }
  | { status: 'denied'; reason: DeniedReason; subject?: VerifiedSubject }
  /** A provider's discovery document or key set could not be fetched; the caller retries. */
  | { status: 'unavailable' };

const FLY_ISSUER_PREFIX = 'https://oidc.fly.io/';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** Every provider signs with RS256; their discovery documents say so. */
const ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 60;
/** A Fly org slug or a Vercel team slug; Vercel's team id issuer form (`team_...`) is refused. */
const ISSUER_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A provider endpoint failed: network error, timeout, non-200, or a body that is not JSON. */
class ProviderUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProviderUnavailableError';
  }
}

function issuerFor(identity: PolicyIdentity): string | null {
  switch (identity.kind) {
    case 'worker-binding':
      return null;
    case 'fly-oidc':
      return `${FLY_ISSUER_PREFIX}${identity.org}`;
    case 'github-oidc':
      return GITHUB_ISSUER;
    case 'vercel-oidc':
      return `${VERCEL_ISSUER_PREFIX}${identity.teamSlug}`;
  }
}

function claim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' ? value : null;
}

function isKnownProviderIssuer(issuer: string): boolean {
  if (issuer === GITHUB_ISSUER) return true;
  if (issuer.startsWith(VERCEL_ISSUER_PREFIX)) {
    return ISSUER_SLUG.test(issuer.slice(VERCEL_ISSUER_PREFIX.length));
  }
  return (
    issuer.startsWith(FLY_ISSUER_PREFIX) && ISSUER_SLUG.test(issuer.slice(FLY_ISSUER_PREFIX.length))
  );
}

/** Only called for an issuer some policy names, so anything else is a Fly org issuer. */
function providerFor(issuer: string): IdentityProvider {
  if (issuer === GITHUB_ISSUER) return 'github';
  return issuer.startsWith(VERCEL_ISSUER_PREFIX) ? 'vercel' : 'fly';
}

const STABLE_CLAIMS: Record<IdentityProvider, readonly string[]> = {
  github: [
    'repository_id',
    'repository_owner_id',
    'repository',
    'environment',
    'ref',
    'event_name',
  ],
  fly: ['org_id', 'org_name', 'app_id', 'app_name', 'machine_id'],
  // Ids only: team and project names can be renamed and never authorize. `user_id` names the
  // person whose `vercel env pull` or `vercel dev` token was refused.
  vercel: ['owner_id', 'project_id', 'environment', 'custom_environment_id', 'user_id'],
};

function verifiedSubject(
  provider: IdentityProvider,
  payload: JWTPayload,
  workload: string | null
): VerifiedSubject {
  const claims: Record<string, string> = {};
  for (const name of STABLE_CLAIMS[provider]) {
    const value = claim(payload, name);
    if (value !== null) claims[name] = value.slice(0, 200);
  }
  return { provider, actor: workload ?? providerId(provider, claims), claims };
}

function providerId(provider: IdentityProvider, claims: Record<string, string>): string {
  switch (provider) {
    case 'github':
      return `github:${claims.repository_id ?? 'unknown'}`;
    case 'fly':
      return `fly:${claims.org_id ?? 'unknown'}/${claims.app_id ?? 'unknown'}`;
    case 'vercel':
      return `vercel:${claims.owner_id ?? 'unknown'}/${claims.project_id ?? 'unknown'}`;
  }
}

/**
 * A Vercel token's `sub` is `owner:<team slug>:project:<project name>:environment:<environment>`
 * (https://vercel.com/docs/oidc/reference). The names only have to agree with the token's own
 * claims and issuer; the ids decide the policy.
 */
function isConsistentVercelToken(payload: JWTPayload, teamSlug: string): boolean {
  const owner = claim(payload, 'owner');
  const project = claim(payload, 'project');
  const environment = claim(payload, 'environment');
  if (owner !== teamSlug || project === null || environment === null) return false;
  return claim(payload, 'sub') === `owner:${owner}:project:${project}:environment:${environment}`;
}

/**
 * The policy entry a Vercel token's environment matches. A custom environment matches only by its
 * stable `custom_environment_id`, never by its slug.
 */
function listedVercelEnvironment(
  payload: JWTPayload,
  listed: readonly VercelEnvironment[]
): VercelEnvironment | null {
  if (payload.custom_environment_id !== undefined) {
    const id = claim(payload, 'custom_environment_id');
    return (
      listed.find(entry => typeof entry !== 'string' && entry.customEnvironmentId === id) ?? null
    );
  }
  const environment = claim(payload, 'environment');
  return listed.find(entry => entry === environment) ?? null;
}

/**
 * An exchanged function token's `act` names the base token's audience, the team default
 * `https://vercel.com/<team slug>`, and nothing nested: a token exchanged from an already exchanged
 * token, or one without `act`, did not come from a function's own token.
 */
function isExchangedFromFunctionToken(payload: JWTPayload, issuer: string): boolean {
  const act = payload.act;
  if (typeof act !== 'object' || act === null || Array.isArray(act)) return false;
  if ('act' in act) return false;
  const teamSlug = issuer.slice(VERCEL_ISSUER_PREFIX.length);
  return 'aud' in act && act.aud === `https://vercel.com/${teamSlug}`;
}

function isPrivilegedEvent(event: string | null): boolean {
  return GITHUB_PRIVILEGED_EVENTS.some(privileged => privileged === event);
}

/** Classifies a failed `jwtVerify`: a dependency failure is retryable, anything else is a rejection. */
function isDependencyFailure(error: unknown): boolean {
  return (
    error instanceof ProviderUnavailableError ||
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid
  );
}

/**
 * Verifies provider workload tokens and maps them to a policy. Each policy's own fields decide the
 * issuer and the claim bindings, so an unlisted identity can never match. The audience is always
 * this STS's issuer. Discovery and key sets are cached for the isolate; a fetch that fails is not
 * cached, and it makes the answer `unavailable`, never a rejection (design 7).
 *
 * Only a finished discovery is cached, never its promise: workerd ties a promise to the request
 * that created it, so a request awaiting another request's pending discovery stalls when that
 * request ends first. jose's key set holds plain data and, on Workers, makes each request that
 * needs a reload fetch for itself rather than share a pending fetch.
 */
export class IdentityVerifier {
  private readonly jwks = new Map<string, RemoteJWKSet>();

  constructor(
    private readonly options: {
      policies: Policy[];
      environment: StsEnvironment;
      issuer: string;
      fetch: typeof fetch;
    }
  ) {}

  private async providerFetch(url: string, init?: RequestInit): Promise<Response> {
    const timeout = AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch {
      throw new ProviderUnavailableError('provider request failed');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ProviderUnavailableError(`provider answered ${response.status}`);
    }
    const text = await response.text();
    try {
      JSON.parse(text);
    } catch {
      throw new ProviderUnavailableError('provider answered with a body that is not JSON');
    }
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** A request that finds no key set for the issuer discovers it itself and stores the result. */
  private async jwksFor(issuer: string): Promise<RemoteJWKSet> {
    const existing = this.jwks.get(issuer);
    if (existing) return existing;

    const response = await this.providerFetch(`${issuer}/.well-known/openid-configuration`);
    const document = DiscoverySchema.safeParse(await response.json());
    if (!document.success) throw new ProviderUnavailableError('discovery document is invalid');
    if (document.data.issuer !== issuer) {
      throw new ProviderUnavailableError('discovery issuer does not match');
    }
    const created = createRemoteJWKSet(new URL(document.data.jwks_uri), {
      timeoutDuration: PROVIDER_FETCH_TIMEOUT_MS,
      [customFetch]: (url, init) => this.providerFetch(url, init),
    });
    this.jwks.set(issuer, created);
    return created;
  }

  async verify(token: string): Promise<VerifyOutcome> {
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(token);
    } catch {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    const issuer = claim(unverified, 'iss');
    if (issuer === null) return { status: 'denied', reason: 'identity_rejected' };

    const candidates = this.options.policies.filter(
      policy => issuerFor(policy.identity) === issuer
    );
    if (candidates.length === 0) {
      return {
        status: 'denied',
        reason: isKnownProviderIssuer(issuer) ? 'unknown_workload' : 'identity_rejected',
      };
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, await this.jwksFor(issuer), {
        issuer,
        audience: this.options.issuer,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      payload = result.payload;
    } catch (error) {
      if (isDependencyFailure(error)) return { status: 'unavailable' };
      return { status: 'denied', reason: 'identity_rejected' };
    }

    const provider = providerFor(issuer);
    const { exp, iat } = payload;
    // jose checks `exp` and `nbf` but not a future `iat`; both times must be present.
    if (exp === undefined || iat === undefined) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    if (iat > Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SECONDS) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    // An exchanged Vercel token carries exactly one audience; anything else (the team-wide default
    // `https://vercel.com/<team>`, or a list naming STS among others) did not come from the exchange.
    if (provider === 'vercel' && payload.aud !== this.options.issuer) {
      return { status: 'denied', reason: 'identity_rejected' };
    }
    const verified = (workload: WorkloadName): VerifyOutcome => ({
      status: 'verified',
      workload,
      provider,
      attestationExp: exp,
      attestationIat: iat,
    });
    const rejected = (workload: string | null, reason: DeniedReason): VerifyOutcome => ({
      status: 'denied',
      reason,
      subject: verifiedSubject(provider, payload, workload),
    });
    if (provider === 'vercel') {
      // A person's `vercel env pull` or `vercel dev` token carries `user_id`; a deployment's
      // function token does not. Refused in every environment, naming the person.
      if (payload.user_id !== undefined) return rejected(null, 'identity_rejected');
      if (!isExchangedFromFunctionToken(payload, issuer)) {
        return rejected(null, 'identity_rejected');
      }
    }
    let mismatchedWorkload: string | null = null;
    for (const policy of candidates) {
      const identity = policy.identity;
      switch (identity.kind) {
        case 'fly-oidc': {
          if (claim(payload, 'org_id') !== identity.orgId) continue;
          if (claim(payload, 'app_id') !== identity.appId) continue;
          if (claim(payload, 'org_name') !== identity.org) continue;
          if (claim(payload, 'app_name') !== identity.app) continue;
          if (!policy.environments.includes(this.options.environment)) {
            mismatchedWorkload = policy.workload;
            continue;
          }
          return verified(policy.workload);
        }
        case 'github-oidc': {
          if (claim(payload, 'repository_id') !== identity.repositoryId) continue;
          if (claim(payload, 'repository_owner_id') !== identity.repositoryOwnerId) continue;
          // From here the token names this policy's repository: a failed binding is a
          // rejection, not an unknown workload.
          const environment = claim(payload, 'environment');
          if (identity.environments && !identity.environments.includes(environment ?? '')) {
            return rejected(policy.workload, 'identity_rejected');
          }
          if (identity.refs && !identity.refs.includes(claim(payload, 'ref') ?? '')) {
            return rejected(policy.workload, 'identity_rejected');
          }
          const event = claim(payload, 'event_name');
          if (isPrivilegedEvent(event) && !identity.allowedEvents?.some(name => name === event)) {
            return rejected(policy.workload, 'identity_rejected');
          }
          if (!policy.environments.includes(this.options.environment)) {
            mismatchedWorkload = policy.workload;
            continue;
          }
          return verified(policy.workload);
        }
        case 'vercel-oidc': {
          if (claim(payload, 'owner_id') !== identity.teamId) continue;
          if (claim(payload, 'project_id') !== identity.projectId) continue;
          // From here the token names this policy's project: a failed binding is a rejection.
          if (!isConsistentVercelToken(payload, identity.teamSlug)) {
            return rejected(policy.workload, 'identity_rejected');
          }
          const source = listedVercelEnvironment(payload, identity.environments);
          if (source === null) return rejected(policy.workload, 'identity_rejected');
          if (
            !policy.environments.includes(this.options.environment) ||
            !vercelStsEnvironments(source).includes(this.options.environment)
          ) {
            mismatchedWorkload = policy.workload;
            continue;
          }
          return verified(policy.workload);
        }
        case 'worker-binding':
          continue;
      }
    }

    return mismatchedWorkload !== null
      ? rejected(mismatchedWorkload, 'environment_mismatch')
      : rejected(null, 'unknown_workload');
  }
}
