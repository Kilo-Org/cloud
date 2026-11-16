import { z } from 'zod';
import { awsByocConfigurationSchema } from './aws-byoc';
import { egressDomainSchema } from './egress-allowlist';

export const AWS_EGRESS_PROTOCOL_VERSION = 1;
export const AWS_EGRESS_POLICY_REFRESH_MS = 15_000;
export const AWS_EGRESS_POLICY_TTL_MS = 30_000;
export const AWS_EGRESS_MAX_CLOCK_SKEW_MS = 5_000;
export const AWS_EGRESS_CONTROL_TIMEOUT_MS = 15_000;
export const AWS_EGRESS_PORT = 3128;
export const AWS_EGRESS_AUDIENCE = 'kilo-aws-egress';
export const AWS_EGRESS_IDENTITY_HEADER = 'x-kilo-egress-identity';
export const AWS_EGRESS_CREDENTIAL_HEADER = 'x-kilo-egress-credential';
export const AWS_EGRESS_TARGET_HEADER = 'x-kilo-egress-target';
export const AWS_EGRESS_PUBLIC_KEY = 'kilo/proxy/public/deployment.json';
export const AWS_EGRESS_SHARED_KEY = 'kilo/proxy/shared/auth.json';

const deploymentIdentity = {
  protocolVersion: z.literal(AWS_EGRESS_PROTOCOL_VERSION),
  generation: z.uuid(),
  stackId: awsByocConfigurationSchema.shape.stackId,
};
export const awsEgressPublicDeploymentSchema = z
  .object({
    ...deploymentIdentity,
    hostname: egressDomainSchema,
    port: z.literal(AWS_EGRESS_PORT),
    caCertificate: z.string().min(128).max(16_384),
    caFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type AwsEgressPublicDeployment = z.infer<typeof awsEgressPublicDeploymentSchema>;

export const awsEgressSharedIdentitySchema = z
  .object({
    ...deploymentIdentity,
    secret: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AwsEgressSharedIdentity = z.infer<typeof awsEgressSharedIdentitySchema>;

export const awsEgressClaimsSchema = z
  .object({
    type: z.literal('aws_egress'),
    aud: z.literal(AWS_EGRESS_AUDIENCE),
    sandboxId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
    allocationId: z.uuid(),
    credential: z.string().regex(/^[a-f0-9]{64}$/),
    generation: deploymentIdentity.generation,
    stackId: deploymentIdentity.stackId,
    exp: z.number().int().positive(),
  })
  .strict();
export type AwsEgressClaims = z.infer<typeof awsEgressClaimsSchema>;

export const awsEgressPolicySchema = z
  .object({
    ...deploymentIdentity,
    sandboxId: awsEgressClaimsSchema.shape.sandboxId,
    allocationId: awsEgressClaimsSchema.shape.allocationId,
    allocationRef: z.string().min(1).max(512),
    validUntil: z.number().int().positive(),
    allowlist: z.array(egressDomainSchema).max(256).optional(),
    audit: z.boolean(),
    interceptedHosts: z.array(egressDomainSchema).max(32),
  })
  .strict();
export type AwsEgressPolicy = z.infer<typeof awsEgressPolicySchema>;
