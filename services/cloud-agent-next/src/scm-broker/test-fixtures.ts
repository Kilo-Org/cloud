import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import type { ByocVercelCredential } from '../byoc/vercel-credential-resolver.js';
import { createControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import type { VercelSandboxIdentityContract } from './vercel-identity.js';
import { configuredVercelForwardUrl } from './targets.js';

export const time = 1_800_000_000_000;
export const logicalId = 'sbx-logical';
export const physicalName = 'allocation-physical';
export const issuer = 'https://oidc.vercel.com/synthetic-team';
const configuredAudience = configuredVercelForwardUrl(
  { WORKER_URL: 'https://worker.test' },
  logicalId
);
if (!configuredAudience) throw new Error('Invalid synthetic forwarding URL');
export const audience = configuredAudience;
export const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const jwk = {
  ...signing.publicKey.export({ format: 'jwk' }),
  kid: 'current',
  alg: 'RS256',
  use: 'sig',
};
export const contract: VercelSandboxIdentityContract = {
  issuerForTeam: team => (team.teamSlug === 'synthetic-team' ? issuer : null),
  sandboxIdForRef: ref => ref.sessionId,
};
export const expected = {
  issuer,
  audience,
  teamId: 'team-test',
  projectId: 'project-test',
  sandboxId: 'provider-immutable-id',
  sandboxName: physicalName,
};
export function token(claims: Record<string, unknown> = {}, kid = 'current') {
  const payload = {
    iss: issuer,
    aud: audience,
    exp: time / 1000 + 600,
    team_id: expected.teamId,
    project_id: expected.projectId,
    sandbox_id: expected.sandboxId,
    ...claims,
  };
  return jwt.sign(
    Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
    signing.privateKey,
    { algorithm: 'RS256', keyid: kid }
  );
}
export function credential(): ByocVercelCredential {
  return {
    organizationId: 'org-test',
    credentialId: 'credential-test',
    setupStatus: 'ready',
    teamId: expected.teamId,
    projectId: expected.projectId,
    teamSlug: 'synthetic-team',
  } as ByocVercelCredential;
}
export function grant(
  purpose: 'github' | 'gitlab' | 'bitbucket' = 'github'
): SessionCredentialGrant {
  const prefix = { github: 'kgh2', gitlab: 'kgl2', bitbucket: 'kbb1' }[purpose];
  const gitUrl =
    purpose === 'github'
      ? 'https://github.com/acme/repo.git'
      : purpose === 'gitlab'
        ? 'https://gitlab.example:8443/gitlab/acme/repo.git'
        : 'https://bitbucket.org/acme/repo.git';
  return {
    version: 1,
    scopeId: 'scope-test',
    sandboxId: logicalId,
    provider: 'vercel',
    userId: 'user-test',
    orgId: 'org-test',
    directory: '/workspace/test',
    outboundContainerId: 'allocation-binding',
    preparedAt: time - 1000,
    expiresAt: time + 3600_000,
    members: [{ sessionId: 'workspace-test', kiloSessionId: 'ses-test' }],
    repository:
      purpose === 'github'
        ? {
            type: 'github',
            repo: 'acme/repo',
            authentication: 'managed',
            allowUserAuthorization: true,
          }
        : purpose === 'gitlab'
          ? { type: 'gitlab', url: gitUrl }
          : {
              type: 'bitbucket',
              url: gitUrl,
              workspaceUuid: 'workspace-uuid',
              repositoryUuid: 'repository-uuid',
            },
    scm: {
      purpose,
      gitUrl,
      alias: createControlPlaneCredential(logicalId, purpose),
      capability: {
        credential: `${prefix}.synthetic`,
        outboundContainerId: 'allocation-binding',
        issuedAt: time - 1000,
        expiresAt: time + 300_000,
      },
      ...(purpose === 'gitlab'
        ? {
            gitlab: {
              instanceOrigin: 'https://gitlab.example:8443/gitlab',
              instanceHost: 'gitlab.example:8443',
              projectPath: 'acme/repo',
              integrationId: 'integration-test',
              authType: 'oauth',
              identity: { accountId: 'account-test', accountLogin: 'account-test' },
              glabIsOAuth2: true,
            },
          }
        : {}),
    },
    kilo: {
      token: 'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln',
      targets: {
        backendBaseUrl: 'https://backend.test',
        providerBaseUrl: 'https://gateway.test',
        sessionIngestBaseUrl: 'https://ingest.test',
      },
      capabilities: {},
      runtimeProxy: {
        targets: {
          backendBaseUrl: 'https://worker.test',
          providerBaseUrl: 'https://worker.test',
          sessionIngestBaseUrl: 'https://worker.test',
        },
        members: [],
      },
    },
  };
}
export function keysFetch() {
  return vi.fn<typeof fetch>(async () => Response.json({ keys: [jwk] }));
}
