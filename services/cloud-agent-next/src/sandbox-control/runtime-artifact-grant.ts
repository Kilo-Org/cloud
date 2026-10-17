import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { SHA256_PATTERN } from '../shared/runtime-release.js';

/**
 * Bounded read grant for the two runtime artifact objects (plan §7 "Artifact
 * Access"). It is a distinct audience and operation from the log-upload grant:
 * a log-upload token must never authorize an artifact read.
 */

const audience = 'cloud-agent-runtime-artifact-read';

/** 10-minute maximum; shorter when the launch budget permits. */
export const RUNTIME_ARTIFACT_GRANT_SECONDS = 600;
/** Authorization header length bound (plan §7: reject overlong values). */
export const RUNTIME_ARTIFACT_GRANT_MAX_HEADER_LENGTH = 4096;

const sha256Schema = z.string().regex(SHA256_PATTERN);

const grantSchema = z
  .object({
    type: z.literal('runtime_artifact_read'),
    aud: z.literal(audience),
    hashes: z.tuple([sha256Schema, sha256Schema]),
    allocationId: z.string().min(1).max(128).optional(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type RuntimeArtifactGrant = {
  hashes: [string, string];
  allocationId?: string;
};

export function mintRuntimeArtifactGrant(
  input: { hashes: [string, string]; allocationId?: string },
  secret: string,
  ttlSeconds: number = RUNTIME_ARTIFACT_GRANT_SECONDS
): string {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > RUNTIME_ARTIFACT_GRANT_SECONDS
  ) {
    throw new Error(`artifact grant lifetime must be 1..${RUNTIME_ARTIFACT_GRANT_SECONDS} seconds`);
  }
  const hashes = [sha256Schema.parse(input.hashes[0]), sha256Schema.parse(input.hashes[1])] as [
    string,
    string,
  ];
  return jwt.sign(
    {
      type: 'runtime_artifact_read',
      hashes,
      ...(input.allocationId === undefined ? {} : { allocationId: input.allocationId }),
    },
    secret,
    { algorithm: 'HS256', audience, expiresIn: ttlSeconds }
  );
}

/**
 * Validate signature, audience, operation, lifetime, and hash membership shape.
 * Returns the two authorized hashes for the caller to match against the request.
 */
export function validateRuntimeArtifactGrant(
  authorization: string | null,
  secret: string | null
): RuntimeArtifactGrant | undefined {
  if (!secret || !authorization) return undefined;
  if (authorization.length > RUNTIME_ARTIFACT_GRANT_MAX_HEADER_LENGTH) return undefined;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return undefined;
  try {
    const parsed = grantSchema.safeParse(
      jwt.verify(match[1], secret, { algorithms: ['HS256'], audience })
    );
    if (!parsed.success) return undefined;
    const { iat, exp, hashes, allocationId } = parsed.data;
    if (exp <= iat || exp - iat > RUNTIME_ARTIFACT_GRANT_SECONDS) return undefined;
    if (iat > Date.now() / 1000 + 30) return undefined;
    return { hashes, ...(allocationId === undefined ? {} : { allocationId }) };
  } catch {
    return undefined;
  }
}

/** True only for one of the two exact hashes the grant names. */
export function runtimeArtifactGrantAllows(grant: RuntimeArtifactGrant, sha256: string): boolean {
  return grant.hashes[0] === sha256 || grant.hashes[1] === sha256;
}
