import { StsEnvironmentSchema, type StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';
import type { BundleDO } from './dos/BundleDO';
import type { RefresherDO } from './dos/RefresherDO';
import type { SignerDO } from './dos/SignerDO';

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

const EnvVarsSchema = z.object({
  STS_ENVIRONMENT: StsEnvironmentSchema,
  STS_ISSUER: z.url().transform(withoutTrailingSlash),
  MANAGER_BASE_URL: z.url().transform(withoutTrailingSlash),
  MANAGER_PROJECT_ID: z.string().min(1),
  MANAGER_ENVIRONMENT_SLUG: z.string().min(1),
  MANAGER_IDENTITY_ID: z.string().min(1),
  DO_JURISDICTION: z.enum(['eu', 'none']),
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
};

export type Env = {
  STS_ENVIRONMENT: string;
  STS_ISSUER: string;
  MANAGER_BASE_URL: string;
  MANAGER_PROJECT_ID: string;
  MANAGER_ENVIRONMENT_SLUG: string;
  MANAGER_IDENTITY_ID: string;
  DO_JURISDICTION: string;
  STS_BUNDLE_DO: DurableObjectNamespace<BundleDO>;
  STS_REFRESHER_DO: DurableObjectNamespace<RefresherDO>;
  STS_SIGNER_DO: DurableObjectNamespace<SignerDO>;
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
  };
}
