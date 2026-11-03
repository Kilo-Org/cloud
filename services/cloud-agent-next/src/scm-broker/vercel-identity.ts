import jwt from 'jsonwebtoken';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { ByocVercelCredential } from '../byoc/vercel-credential-resolver.js';
import type {
  VercelProviderLocator,
  VercelProviderRef,
} from '../sandbox-control/vercel-provider.js';
import { vercelJwksCache, vercelJwksUrl } from './vercel-jwks.js';

const identitySchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  exp: z.number().int().positive(),
  team_id: z.string().min(1),
  project_id: z.string().min(1),
  sandbox_id: z.string().min(1),
  sandbox_name: z.string().min(1).optional(),
});
export type VercelForwardIdentity = z.infer<typeof identitySchema>;
export type VercelIdentityExpectation = {
  issuer: string;
  audience: string;
  teamId: string;
  projectId: string;
  sandboxId: string;
  sandboxName: string;
};

export type VercelSandboxIdentityContract = {
  issuerForTeam: (team: { teamId: string; teamSlug: string | null }) => string | null;
  sandboxIdForRef: (ref: VercelProviderRef) => string | null;
};

// Verified with nonpersistent Vercel sandboxes: the issuer uses the team ID,
// and sandbox_id identifies the physical session, not the logical sandbox name.
export const verifiedVercelSandboxIdentityContract: VercelSandboxIdentityContract = {
  issuerForTeam: ({ teamId }) =>
    /^team_[A-Za-z0-9]+$/.test(teamId) ? `https://oidc.vercel.com/${teamId}` : null,
  sandboxIdForRef: ({ sessionId }) => sessionId,
};

export class VercelScmContainmentError extends Error {
  readonly reason = 'provider_identity_mismatch';

  constructor() {
    super('Vercel Git containment requires verified provider identity and transport contracts');
    this.name = 'VercelScmContainmentError';
  }
}

export function expectedVercelIdentity(input: {
  credential: ByocVercelCredential;
  locator: VercelProviderLocator;
  providerRef: VercelProviderRef;
  physicalName: string;
  audience: string;
  contract: VercelSandboxIdentityContract;
}): VercelIdentityExpectation | null {
  const { credential, locator, providerRef, physicalName, audience, contract } = input;
  if (
    credential.setupStatus !== 'ready' ||
    credential.teamId !== locator.teamId ||
    credential.projectId !== locator.projectId ||
    providerRef.sandboxName !== physicalName
  )
    return null;
  const issuer = contract.issuerForTeam(credential);
  const sandboxId = contract.sandboxIdForRef(providerRef);
  if (!issuer || !vercelJwksUrl(issuer) || !sandboxId) return null;
  return {
    issuer,
    audience,
    teamId: locator.teamId,
    projectId: locator.projectId,
    sandboxId,
    sandboxName: physicalName,
  };
}

export async function authenticateVercelForwardToken(
  token: string,
  expected: VercelIdentityExpectation,
  keys = vercelJwksCache,
  now = Date.now()
): Promise<VercelForwardIdentity | null> {
  if (Buffer.byteLength(token, 'utf8') > 8 * 1024) return null;
  let decoded;
  try {
    decoded = jwt.decode(token, { complete: true });
  } catch {
    return null;
  }
  const header = z
    .object({ alg: z.literal('RS256'), kid: z.string().min(1).max(256) })
    .safeParse(decoded?.header);
  const claims = identitySchema.safeParse(decoded?.payload);
  if (
    !header.success ||
    !claims.success ||
    claims.data.iss !== expected.issuer ||
    claims.data.aud !== expected.audience ||
    claims.data.exp <= now / 1000 ||
    claims.data.team_id !== expected.teamId ||
    claims.data.project_id !== expected.projectId ||
    claims.data.sandbox_id !== expected.sandboxId ||
    (claims.data.sandbox_name !== undefined && claims.data.sandbox_name !== expected.sandboxName)
  )
    return null;
  const key = await keys.key(expected.issuer, header.data.kid);
  if (!key) return null;
  try {
    const verified = jwt.verify(token, key, {
      algorithms: ['RS256'],
      audience: expected.audience,
      issuer: expected.issuer,
      clockTimestamp: Math.floor(now / 1000),
    });
    const identity = identitySchema.safeParse(verified);
    return identity.success ? identity.data : null;
  } catch {
    return null;
  }
}
