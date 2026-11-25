import { StsEnvironmentSchema, type StsEnvironment } from '@kilocode/sts-contracts';
import { z } from 'zod';
import type { BundleDO } from './dos/BundleDO';
import type { RefresherDO } from './dos/RefresherDO';
import type { SignerDO } from './dos/SignerDO';

const EnvVarsSchema = z.object({
  STS_ENVIRONMENT: StsEnvironmentSchema,
  STS_ISSUER: z.url(),
  MANAGER_BASE_URL: z.url().default('https://eu.infisical.com'),
  MANAGER_PROJECT_ID: z.string().min(1),
  MANAGER_ENVIRONMENT_SLUG: z.string().min(1),
  MANAGER_SECRET_PATH: z.string().startsWith('/').default('/runtime'),
  MANAGER_IDENTITY_ID: z.string().min(1),
  DO_JURISDICTION: z.enum(['eu', 'none']).default('none'),
});

export type ManagerConfig = {
  baseUrl: string;
  projectId: string;
  environmentSlug: string;
  secretPath: string;
  identityId: string;
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
  MANAGER_SECRET_PATH: string;
  MANAGER_IDENTITY_ID: string;
  DO_JURISDICTION: string;
  STS_BUNDLE_DO: DurableObjectNamespace<BundleDO>;
  STS_REFRESHER_DO: DurableObjectNamespace<RefresherDO>;
  STS_SIGNER_DO: DurableObjectNamespace<SignerDO>;
  AUDIT_QUEUE: Queue;
};

/** Validates every plain configuration var. Called at the start of each entry. */
export function readConfig(env: Env): StsConfig {
  const vars = EnvVarsSchema.parse(env);
  return {
    environment: vars.STS_ENVIRONMENT,
    issuer: vars.STS_ISSUER.endsWith('/') ? vars.STS_ISSUER.slice(0, -1) : vars.STS_ISSUER,
    jurisdiction: vars.DO_JURISDICTION,
    manager: {
      baseUrl: vars.MANAGER_BASE_URL.endsWith('/')
        ? vars.MANAGER_BASE_URL.slice(0, -1)
        : vars.MANAGER_BASE_URL,
      projectId: vars.MANAGER_PROJECT_ID,
      environmentSlug: vars.MANAGER_ENVIRONMENT_SLUG,
      secretPath: vars.MANAGER_SECRET_PATH,
      identityId: vars.MANAGER_IDENTITY_ID,
    },
  };
}
