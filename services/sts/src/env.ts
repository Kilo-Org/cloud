import { StsEnvironmentSchema, type StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';
import type { BundleDO } from './dos/BundleDO';
import type { DenialDO } from './dos/DenialDO';
import type { RefresherDO } from './dos/RefresherDO';
import type { SignerDO } from './dos/SignerDO';
import type { TokenSignerDO } from './dos/TokenSignerDO';

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** An Ed25519 key's RFC 7638 thumbprint: SHA-256, base64url without padding. */
const KidSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A comma list of token-signing key ids pulled out of service; empty by default (README). */
const RevokedKidsSchema = z
  .string()
  .transform(value =>
    value
      .split(',')
      .map(kid => kid.trim())
      .filter(kid => kid.length > 0)
  )
  .pipe(z.array(KidSchema));

/** Every plain var STS reads; each deployed block of `wrangler.jsonc` sets all of them (repo check). */
export const EnvVarsSchema = z.object({
  STS_ENVIRONMENT: StsEnvironmentSchema,
  STS_ISSUER: z.url().transform(withoutTrailingSlash),
  MANAGER_BASE_URL: z.url().transform(withoutTrailingSlash),
  MANAGER_PROJECT_ID: z.string().min(1),
  MANAGER_ENVIRONMENT_SLUG: z.string().min(1),
  MANAGER_IDENTITY_ID: z.string().min(1),
  DO_JURISDICTION: z.enum(['eu', 'none']),
  TOKEN_SIGNING_KIDS_REVOKED: RevokedKidsSchema,
});

/** The claims Infisical JWT Auth checks on the login JWT; every value is exact (design 4.2). */
export type ManagerLoginClaims = {
  issuer: string;
  audience: string;
  subject: string;
};

export type ManagerConfig = {
  baseUrl: string;
  projectId: string;
  environmentSlug: string;
  identityId: string;
  login: ManagerLoginClaims;
};

export type StsConfig = {
  environment: StsEnvironment;
  issuer: string;
  jurisdiction: 'eu' | 'none';
  manager: ManagerConfig;
  /** Token-signing key ids never used again and dropped from the key set (emergency removal). */
  revokedTokenKids: readonly string[];
};

export type Env = {
  STS_ENVIRONMENT: string;
  STS_ISSUER: string;
  MANAGER_BASE_URL: string;
  MANAGER_PROJECT_ID: string;
  MANAGER_ENVIRONMENT_SLUG: string;
  MANAGER_IDENTITY_ID: string;
  DO_JURISDICTION: string;
  TOKEN_SIGNING_KIDS_REVOKED: string;
  STS_BUNDLE_DO: DurableObjectNamespace<BundleDO>;
  STS_REFRESHER_DO: DurableObjectNamespace<RefresherDO>;
  STS_SIGNER_DO: DurableObjectNamespace<SignerDO>;
  STS_DENIAL_DO: DurableObjectNamespace<DenialDO>;
  STS_TOKEN_SIGNER_DO: DurableObjectNamespace<TokenSignerDO>;
  AUDIT_QUEUE: Queue;
};

/** Path under `STS_ISSUER` that publishes the manager login key set. */
export const MANAGER_AUTH_PATH = '/manager-auth';
export const MANAGER_JWKS_PATH = `${MANAGER_AUTH_PATH}/.well-known/jwks.json`;

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): StsConfig {
  const vars = EnvVarsSchema.parse(env);
  return {
    environment: vars.STS_ENVIRONMENT,
    issuer: vars.STS_ISSUER,
    jurisdiction: vars.DO_JURISDICTION,
    manager: {
      baseUrl: vars.MANAGER_BASE_URL,
      projectId: vars.MANAGER_PROJECT_ID,
      environmentSlug: vars.MANAGER_ENVIRONMENT_SLUG,
      identityId: vars.MANAGER_IDENTITY_ID,
      login: {
        issuer: `${vars.STS_ISSUER}${MANAGER_AUTH_PATH}`,
        audience: `${vars.MANAGER_BASE_URL}/identities/${vars.MANAGER_IDENTITY_ID}`,
        subject: `sts:${vars.STS_ENVIRONMENT}:refresher`,
      },
    },
    revokedTokenKids: vars.TOKEN_SIGNING_KIDS_REVOKED,
  };
}
