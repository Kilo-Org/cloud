import type { StsEnvironment, WorkloadName } from '@kilocode/sts-contracts';
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
  type RemoteJWKSet,
} from 'jose';
import { z } from 'zod';
import type { Policy, PolicyIdentity } from '../policy/schema';

const DiscoverySchema = z.object({
  issuer: z.string().min(1),
  jwks_uri: z.url(),
});

export type IdentityProvider = 'vercel' | 'fly' | 'github';
export type DeniedReason = 'identity_rejected' | 'unknown_workload' | 'environment_mismatch';

export type VerifyOutcome =
  | { status: 'verified'; workload: WorkloadName; provider: IdentityProvider }
  | { status: 'denied'; reason: DeniedReason };

const VERCEL_ISSUER_PREFIX = 'https://oidc.vercel.com/';
const FLY_ISSUER_PREFIX = 'https://oidc.fly.io/';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
/** All three providers sign with RS256; the discovery documents say so. */
const ALGORITHMS = ['RS256'];
const CLOCK_TOLERANCE_SECONDS = 60;

function issuerFor(identity: PolicyIdentity): string | null {
  switch (identity.kind) {
    case 'worker-binding':
      return null;
    case 'vercel-oidc':
      return `${VERCEL_ISSUER_PREFIX}${identity.teamSlug}`;
    case 'fly-oidc':
      return `${FLY_ISSUER_PREFIX}${identity.org}`;
    case 'github-oidc':
      return GITHUB_ISSUER;
  }
}

function audienceFor(identity: PolicyIdentity, stsIssuer: string): string {
  return identity.kind === 'vercel-oidc' ? `https://vercel.com/${identity.teamSlug}` : stsIssuer;
}

function claim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === 'string' ? value : null;
}

function isKnownProviderIssuer(issuer: string): boolean {
  if (issuer === GITHUB_ISSUER || issuer === 'https://oidc.vercel.com') return true;
  if (!issuer.startsWith(VERCEL_ISSUER_PREFIX) && !issuer.startsWith(FLY_ISSUER_PREFIX)) {
    return false;
  }
  const slug = issuer.slice(
    issuer.startsWith(VERCEL_ISSUER_PREFIX) ? VERCEL_ISSUER_PREFIX.length : FLY_ISSUER_PREFIX.length
  );
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
}

function denied(reason: DeniedReason): VerifyOutcome {
  return { status: 'denied', reason };
}

/**
 * Verifies provider workload tokens and maps them to a policy. Each policy's own
 * fields decide the issuer, audience, and claim bindings, so an unlisted identity
 * can never match. Discovery and JWKS responses are cached for the isolate.
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

  private async jwksFor(issuer: string): Promise<RemoteJWKSet> {
    const existing = this.jwks.get(issuer);
    if (existing) return existing;

    const created = (async () => {
      const response = await this.options.fetch(`${issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`discovery failed with status ${response.status}`);
      const document = DiscoverySchema.parse(await response.json());
      if (document.issuer !== issuer) throw new Error('discovery issuer does not match');
      return createRemoteJWKSet(new URL(document.jwks_uri), {
        [customFetch]: this.options.fetch,
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
      return denied('identity_rejected');
    }
    const issuer = claim(unverified, 'iss');
    if (issuer === null) return denied('identity_rejected');

    const candidates = this.options.policies.filter(
      policy => issuerFor(policy.identity) === issuer
    );
    if (candidates.length === 0) {
      return denied(isKnownProviderIssuer(issuer) ? 'unknown_workload' : 'identity_rejected');
    }

    const audience = audienceFor(candidates[0].identity, this.options.issuer);
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, await this.jwksFor(issuer), {
        issuer,
        audience,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      payload = result.payload;
    } catch {
      return denied('identity_rejected');
    }

    let environmentMismatch = false;
    for (const policy of candidates) {
      const identity = policy.identity;
      switch (identity.kind) {
        case 'vercel-oidc': {
          if (claim(payload, 'project_id') !== identity.projectId) continue;
          if (!policy.environments.includes(this.options.environment)) {
            environmentMismatch = true;
            continue;
          }
          const environment = claim(payload, 'environment');
          if (environment === null) return denied('identity_rejected');
          const servedByThisDeployment =
            this.options.environment === 'production'
              ? environment === 'production'
              : environment !== 'production';
          if (!servedByThisDeployment || !identity.vercelEnvironments.includes(environment)) {
            environmentMismatch = true;
            continue;
          }
          return { status: 'verified', workload: policy.workload, provider: 'vercel' };
        }
        case 'fly-oidc': {
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
          const refMatches = identity.refs?.includes(claim(payload, 'ref') ?? '') === true;
          const environmentMatches =
            identity.environments?.includes(claim(payload, 'environment') ?? '') === true;
          if (!refMatches && !environmentMatches) return denied('identity_rejected');
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

    return denied(environmentMismatch ? 'environment_mismatch' : 'unknown_workload');
  }
}
