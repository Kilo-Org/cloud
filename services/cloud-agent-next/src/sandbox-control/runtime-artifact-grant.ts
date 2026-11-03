import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { SHA256_PATTERN } from './runtime-release.js';

const audience = 'cloud-agent-runtime-artifact-read';
export const RUNTIME_ARTIFACT_GRANT_MAX_HEADER_LENGTH = 4096;
const hashesSchema = z.tuple([z.string().regex(SHA256_PATTERN), z.string().regex(SHA256_PATTERN)]);
const grantSchema = z
  .object({
    type: z.literal('runtime_artifact_read'),
    aud: z.literal(audience),
    hashes: hashesSchema,
    iat: z.number().int().nonnegative(),
    exp: z.number().nonnegative(),
  })
  .strict();
export type RuntimeArtifactGrant = { hashes: [string, string] };

/** Never persist the result. The allocation's latest first-connect deadline owns expiry. */
export function mintRuntimeArtifactGrant(
  hashes: [string, string],
  secret: string,
  expiresAt: number
): string {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
    throw new Error('Runtime grant deadline passed');
  return jwt.sign(
    { type: 'runtime_artifact_read', hashes: hashesSchema.parse(hashes), exp: expiresAt / 1000 },
    secret,
    { algorithm: 'HS256', audience }
  );
}

export function validateRuntimeArtifactGrant(
  authorization: string | null,
  secret: string | null
): RuntimeArtifactGrant | undefined {
  if (!secret || !authorization || authorization.length > RUNTIME_ARTIFACT_GRANT_MAX_HEADER_LENGTH)
    return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      jwt.verify(match[1], secret, { algorithms: ['HS256'], audience })
    );
    if (
      !parsed.success ||
      parsed.data.exp <= parsed.data.iat ||
      parsed.data.iat > Date.now() / 1000 + 30
    )
      return undefined;
    return { hashes: parsed.data.hashes };
  } catch {
    return undefined;
  }
}
