import jwt from 'jsonwebtoken';
import { awsEgressClaimsSchema, AWS_EGRESS_AUDIENCE } from '@kilocode/worker-utils/aws-egress';
import { AWS_MICROVM_MAXIMUM_DURATION_SECONDS } from '@kilocode/worker-utils/aws-byoc';
import { verifySandboxLaunchCredential } from '../sandbox-control/credential.js';

/** A distinct audience prevents a proxy credential from authorizing wrapper or preview sockets. */
export function mintAwsEgressCredential(
  input: {
    launchCredential: string;
    generation: string;
    stackId: string;
  },
  secret: string
): string {
  const launch = verifySandboxLaunchCredential(input.launchCredential, secret);
  if (!launch) throw new Error('AWS egress launch identity is invalid');
  const payload = awsEgressClaimsSchema.omit({ exp: true }).parse({
    type: 'aws_egress',
    aud: AWS_EGRESS_AUDIENCE,
    sandboxId: launch.sandboxId,
    allocationId: launch.allocationId,
    credential: launch.credential,
    generation: input.generation,
    stackId: input.stackId,
  });
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    noTimestamp: true,
    expiresIn: AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
  });
}

export function verifyAwsEgressCredential(token: string, secret: string, now = Date.now()) {
  if (!token || token.length > 4096) return null;
  try {
    return (
      awsEgressClaimsSchema.safeParse(
        jwt.verify(token, secret, {
          algorithms: ['HS256'],
          audience: AWS_EGRESS_AUDIENCE,
          clockTimestamp: Math.floor(now / 1000),
        })
      ).data ?? null
    );
  } catch {
    return null;
  }
}
