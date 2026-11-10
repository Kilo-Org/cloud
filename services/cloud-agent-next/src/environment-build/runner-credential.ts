import jwt from 'jsonwebtoken';
import { z } from 'zod';

/**
 * The build-specific launch credential (plan: "Bind its launch credential and
 * every result to environment, build, allocation, and connection identities").
 * It reuses the wrapper launch signing primitive (HS256 with the Worker signing
 * secret, a random 32-byte credential whose hash the coordinator stores) with a
 * distinct audience and purpose, so a session credential can never act as a
 * builder and a builder credential can never reach a Sandbox DO.
 */

const RUNNER_AUDIENCE = 'cloud-agent-environment-build-runner';
const RUNNER_CREDENTIAL_MAX_CHARS = 2048;

const runnerCredentialSchema = z
  .object({
    type: z.literal('environment_build_runner'),
    aud: z.literal(RUNNER_AUDIENCE),
    environmentId: z.string().uuid(),
    buildId: z.string().uuid(),
    allocationId: z.string().uuid(),
    credential: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type RunnerCredentialClaims = Omit<z.infer<typeof runnerCredentialSchema>, 'type' | 'aud'>;

export function mintRunnerCredential(claims: RunnerCredentialClaims, secret: string): string {
  return jwt.sign(
    runnerCredentialSchema.parse({
      ...claims,
      type: 'environment_build_runner',
      aud: RUNNER_AUDIENCE,
    }),
    secret,
    { algorithm: 'HS256', noTimestamp: true }
  );
}

export function verifyRunnerCredential(
  token: string,
  secret: string
): RunnerCredentialClaims | null {
  if (token.length === 0 || token.length > RUNNER_CREDENTIAL_MAX_CHARS) return null;
  try {
    const parsed = runnerCredentialSchema.safeParse(
      jwt.verify(token, secret, { algorithms: ['HS256'], audience: RUNNER_AUDIENCE })
    );
    if (!parsed.success) return null;
    const { type: _type, aud: _aud, ...claims } = parsed.data;
    return claims;
  } catch {
    return null;
  }
}

/** The bearer of a builder request, or null for a missing or oversized header. */
export function parseRunnerBearer(authorization: string | null): string | null {
  if (!authorization || authorization.length > RUNNER_CREDENTIAL_MAX_CHARS + 7) return null;
  const match = /^Bearer (\S+)$/.exec(authorization);
  return match?.[1] ?? null;
}
