import type { UtsEnvironment } from '@kilocode/uts-contracts';
import type { UtsConfig } from '../env';

/** Path under the issuer origin that publishes the manager login key set (design 4.2, 5.2). */
export const MANAGER_AUTH_PATH = '/manager-auth';
export const MANAGER_JWKS_PATH = `${MANAGER_AUTH_PATH}/.well-known/jwks.json`;

/** The only folder UTS writes to in the secrets manager (design 5.2). */
export const IDENTITY_STORE_FOLDER = '/admin/identity-store';

/**
 * The folder of the identity-store login seeds, one secret per login named by the login (decision
 * Q88, the `/db-switch` convention of M8). Only `uts-rotation-<environment>` reads it, and only once
 * the rotation phase grants `readValue` there; a secret admin deletes each seed after that login's
 * first rotation.
 */
export const LOGIN_SEED_FOLDER = '/db-switch/uts';

/** Infisical Cloud, EU region (design 4.1). */
const INFISICAL_EU = 'https://eu.infisical.com';

/** The project that holds `/admin/identity-store`, the one STS reads its folders from. */
const MANAGER_PROJECT_ID = '8cf601df-1c5a-4c8f-9e21-7e9af6728b06';

type ManagerIdentity = {
  /** The machine identity `uts-rotation-<environment>`, which logs in with Infisical JWT Auth. */
  identityId: string;
  /** The manager environment slug the identity's role is scoped to. */
  environmentSlug: string;
};

/**
 * One identity per environment (design 4.2). Development names a synthetic identity that exists
 * only in the stand-in manager of the local end-to-end run.
 */
export const MANAGER_IDENTITIES: Readonly<Record<UtsEnvironment, ManagerIdentity>> = {
  production: {
    identityId: '35559137-4dbb-466e-9673-1d9ecd3d3ec5',
    environmentSlug: 'production',
  },
  staging: { identityId: '49efdbc2-f186-4ae0-ba06-941d4b311b21', environmentSlug: 'staging' },
  development: {
    identityId: '00000000-0000-4000-8000-000000000000',
    environmentSlug: 'development',
  },
};

/** The claims Infisical JWT Auth checks on the login JWT; the identity trusts each value exactly. */
export type ManagerLoginClaims = { issuer: string; subject: string; audience: string };

export type ManagerConfig = {
  baseUrl: string;
  projectId: string;
  environmentSlug: string;
  identityId: string;
  login: ManagerLoginClaims;
};

/** The login claims of this environment's identity, derived from the issuer origin. */
export function managerLoginClaims(config: UtsConfig): ManagerLoginClaims {
  const { identityId } = MANAGER_IDENTITIES[config.environment];
  return {
    issuer: `${config.endpoints.issuer}${MANAGER_AUTH_PATH}`,
    subject: `uts:${config.environment}:rotation`,
    audience: `${INFISICAL_EU}/identities/${identityId}`,
  };
}

/**
 * The manager this environment logs in to. Staging and production always use Infisical Cloud;
 * development uses `MANAGER_BASE_URL`, a local stand-in, and has no manager without it.
 */
export function managerConfig(config: UtsConfig): ManagerConfig | null {
  const baseUrl = config.environment === 'development' ? config.managerBaseUrl : INFISICAL_EU;
  if (baseUrl === null) return null;
  const identity = MANAGER_IDENTITIES[config.environment];
  return {
    baseUrl,
    projectId: MANAGER_PROJECT_ID,
    environmentSlug: identity.environmentSlug,
    identityId: identity.identityId,
    login: managerLoginClaims(config),
  };
}
