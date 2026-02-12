import { jwtVerify, createRemoteJWKSet } from 'jose';

const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

const jwks = createRemoteJWKSet(new URL(GITHUB_JWKS_URL));

export type GitHubOIDCTokenPayload = {
  sub: string;
  repository: string;
  repository_owner: string;
  repository_owner_id: string;
  repository_id: string;
  repository_visibility: string;
  run_id: string;
  run_number: string;
  run_attempt: string;
  actor: string;
  actor_id: string;
  workflow: string;
  ref: string;
  ref_type: string;
  environment?: string;
  job_workflow_ref: string;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  jti: string;
};

export async function verifyGitHubOIDCToken(
  token: string,
  expectedAudience: string
): Promise<GitHubOIDCTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: expectedAudience,
    });

    return payload as GitHubOIDCTokenPayload;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`OIDC token verification failed: ${error.message}`);
    }
    throw new Error('OIDC token verification failed');
  }
}
