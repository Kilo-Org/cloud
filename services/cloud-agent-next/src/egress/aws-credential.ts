import jwt from 'jsonwebtoken';
import {
  awsEc2EgressClaimsSchema,
  AWS_EC2_EGRESS_AUDIENCE,
  type AwsEc2EgressClaims,
} from '@kilocode/worker-utils/aws-egress';

/** A distinct audience prevents proxy credentials from authorizing wrapper or preview sockets. */
export function mintAwsEc2EgressCredential(
  input: Omit<AwsEc2EgressClaims, 'type' | 'aud' | 'exp'>,
  secret: string,
  expiresAt: number
): string {
  const payload = awsEc2EgressClaimsSchema.parse({
    ...input,
    type: 'aws_ec2_egress',
    aud: AWS_EC2_EGRESS_AUDIENCE,
    exp: Math.floor(expiresAt / 1000),
  });
  return jwt.sign(payload, secret, { algorithm: 'HS256', noTimestamp: true });
}

export function verifyAwsEc2EgressCredential(token: string, secret: string, now = Date.now()) {
  if (!token || token.length > 4096) return null;
  try {
    const claims: unknown = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: AWS_EC2_EGRESS_AUDIENCE,
      clockTimestamp: Math.floor(now / 1000),
    });
    return awsEc2EgressClaimsSchema.safeParse(claims).data ?? null;
  } catch {
    return null;
  }
}
