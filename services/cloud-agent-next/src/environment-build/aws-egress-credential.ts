import jwt from 'jsonwebtoken';
import {
  AWS_BUILD_EGRESS_AUDIENCE,
  awsBuildEgressClaimsSchema,
} from '@kilocode/worker-utils/aws-egress';
import { verifyRunnerCredential } from './runner-credential.js';

/** The signed runner identity is required before minting a separate build proxy credential. */
export function mintAwsBuildEgressCredential(
  input: {
    runnerCredential: string;
    provider: 'aws-ecs';
    environmentId: string;
    buildId: string;
    allocationId: string;
    sandboxId: string;
    actorUserId: string;
    credentialId: string;
    generation: string;
    stackId: string;
    expiresAt: number;
  },
  secret: string
): string {
  const runner = verifyRunnerCredential(input.runnerCredential, secret);
  if (
    !runner ||
    runner.environmentId !== input.environmentId ||
    runner.buildId !== input.buildId ||
    runner.allocationId !== input.allocationId ||
    !Number.isSafeInteger(input.expiresAt) ||
    Math.floor(input.expiresAt / 1000) <= Math.floor(Date.now() / 1000)
  )
    throw new Error('AWS build proxy identity is invalid');
  const payload = awsBuildEgressClaimsSchema.parse({
    type: 'aws_build_egress',
    aud: AWS_BUILD_EGRESS_AUDIENCE,
    provider: input.provider,
    environmentId: runner.environmentId,
    buildId: runner.buildId,
    sandboxId: input.sandboxId,
    allocationId: runner.allocationId,
    credential: runner.credential,
    actorUserId: input.actorUserId,
    credentialId: input.credentialId,
    generation: input.generation,
    stackId: input.stackId,
    exp: Math.floor(input.expiresAt / 1000),
  });
  return jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });
}

export function verifyAwsBuildEgressCredential(token: string, secret: string, now = Date.now()) {
  if (!token || token.length > 4096) return null;
  try {
    return (
      awsBuildEgressClaimsSchema.safeParse(
        jwt.verify(token, secret, {
          algorithms: ['HS256'],
          audience: AWS_BUILD_EGRESS_AUDIENCE,
          clockTimestamp: Math.floor(now / 1000),
        })
      ).data ?? null
    );
  } catch {
    return null;
  }
}
