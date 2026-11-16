import jwt from 'jsonwebtoken';
import { awsEgressClaimsSchema, AWS_EGRESS_AUDIENCE } from '@kilocode/worker-utils/aws-egress';
import { AWS_MICROVM_MAXIMUM_DURATION_SECONDS } from '@kilocode/worker-utils/aws-byoc';
import { verifySandboxLaunchCredential } from '../sandbox-control/credential.js';

type AwsEgressMintIdentity = { launchCredential: string; generation: string; stackId: string };

/** MicroVM credentials retain the provider's eight-hour lifetime. */
export function mintAwsEgressCredential(input: AwsEgressMintIdentity, secret: string): string {
  return mintAwsEgressCredentialUntil(
    input,
    secret,
    Date.now() + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000
  );
}

/** A distinct audience prevents proxy credentials from authorizing wrapper or preview sockets. */
export function mintAwsEgressCredentialUntil(
  input: AwsEgressMintIdentity,
  secret: string,
  expiresAt: number
): string {
  if (
    !Number.isSafeInteger(expiresAt) ||
    Math.floor(expiresAt / 1000) <= Math.floor(Date.now() / 1000)
  )
    throw new Error('AWS egress credential expiry is invalid');
  const launch = verifySandboxLaunchCredential(input.launchCredential, secret);
  if (!launch) throw new Error('AWS egress launch identity is invalid');
  const payload = awsEgressClaimsSchema.parse({
    type: 'aws_egress',
    aud: AWS_EGRESS_AUDIENCE,
    sandboxId: launch.sandboxId,
    allocationId: launch.allocationId,
    credential: launch.credential,
    generation: input.generation,
    stackId: input.stackId,
    exp: Math.floor(expiresAt / 1000),
  });
  return jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });
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
