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
import { GITHUB_PRIVILEGED_EVENTS, type Policy, type PolicyIdentity } from '../policy/schema';

const DiscoverySchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.url(),
});

export type IdentityProvider = 'fly' | 'github';
export type DeniedReason = 'identity_rejected' | 'unknown_workload' | 'environment_mismatch';

export type VerifyOutcome =
  | { status: 'verified'; workload: WorkloadName; provider: IdentityProvider }
  | { status: 'denied'; reason: DeniedReason }
  /** A provider's discovery document or key set could not be fetched; the caller retries. */
  | { status: 'unavailable' };

const FLY_ISSUER_PREFIX = 'https://oidc.fly.io/';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** Both providers sign with RS256; their discovery documents say so. */
const ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 60;

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
  }
}

function claim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' ? value : null;
}

function isKnownProviderIssuer(issuer: string): boolean {
  if (issuer === GITHUB_ISSUER) return true;
  return (
    issuer.startsWith(FLY_ISSUER_PREFIX) &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(issuer.slice(FLY_ISSUER_PREFIX.length))
  );
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
 */
export class IdentityVerifier {
  private readonly jwks = new Map<string, Promise<RemoteJWKSet>>();

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

  private jwksFor(issuer: string): Promise<RemoteJWKSet> {
    const existing = this.jwks.get(issuer);
    if (existing) return existing;

    const created = (async () => {
      const response = await this.providerFetch(`${issuer}/.well-known/openid-configuration`);
      const document = DiscoverySchema.safeParse(await response.json());
      if (!document.success) throw new ProviderUnavailableError('discovery document is invalid');
      if (document.data.issuer !== issuer) {
        throw new ProviderUnavailableError('discovery issuer does not match');
      }
      return createRemoteJWKSet(new URL(document.data.jwks_uri), {
        timeoutDuration: PROVIDER_FETCH_TIMEOUT_MS,
        [customFetch]: (url, init) => this.providerFetch(url, init),
      });
    })();
    this.jwks.set(issuer, created);
    void created.catch(() => this.jwks.delete(issuer));
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

    let environmentMismatch = false;
    for (const policy of candidates) {
      const identity = policy.identity;
      switch (identity.kind) {
        case 'fly-oidc': {
          if (claim(payload, 'org_id') !== identity.orgId) continue;
          if (claim(payload, 'app_id') !== identity.appId) continue;
          if (claim(payload, 'org_name') !== identity.org) continue;
          if (claim(payload, 'app_name') !== identity.app) continue;
          if (!policy.environments.includes(this.options.environment)) {
            environmentMismatch = true;
            continue;
          }
          return { status: 'verified', workload: policy.workload, provider: 'fly' };
        }
        case 'github-oidc': {
          if (claim(payload, 'repository_id') !== identity.repositoryId) continue;
          if (claim(payload, 'repository_owner_id') !== identity.repositoryOwnerId) continue;
          // From here the token names this policy's repository: a failed binding is a
          // rejection, not an unknown workload.
          const environment = claim(payload, 'environment');
          if (identity.environments && !identity.environments.includes(environment ?? '')) {
            return { status: 'denied', reason: 'identity_rejected' };
          }
          if (identity.refs && !identity.refs.includes(claim(payload, 'ref') ?? '')) {
            return { status: 'denied', reason: 'identity_rejected' };
          }
          const event = claim(payload, 'event_name');
          if (isPrivilegedEvent(event) && !identity.allowedEvents?.some(name => name === event)) {
            return { status: 'denied', reason: 'identity_rejected' };
          }
          if (!policy.environments.includes(this.options.environment)) {
            environmentMismatch = true;
            continue;
          }
          return { status: 'verified', workload: policy.workload, provider: 'github' };
        }
        case 'worker-binding':
          continue;
      }
    }

    return {
      status: 'denied',
      reason: environmentMismatch ? 'environment_mismatch' : 'unknown_workload',
    };
  }
}
