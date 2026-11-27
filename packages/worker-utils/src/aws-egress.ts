import { z } from 'zod';
import { awsStackIdSchema } from './aws-byoc';
import { awsEc2InstanceIdSchema, awsEc2VolumeIdSchema } from './aws-ec2';
import { egressDomainSchema } from './egress-allowlist';

export const AWS_EGRESS_PROTOCOL_VERSION = 1;
export const AWS_EGRESS_POLICY_REFRESH_MS = 15_000;
export const AWS_EGRESS_POLICY_TTL_MS = 30_000;
export const AWS_EGRESS_MAX_CLOCK_SKEW_MS = 5_000;
export const AWS_EGRESS_CONTROL_TIMEOUT_MS = 15_000;
export const AWS_EC2_EGRESS_AUDIENCE = 'kilo-aws-ec2-egress';
export const AWS_EGRESS_IDENTITY_HEADER = 'x-kilo-egress-identity';
export const AWS_EGRESS_CREDENTIAL_HEADER = 'x-kilo-egress-credential';
export const AWS_EGRESS_TARGET_HEADER = 'x-kilo-egress-target';

const deploymentIdentity = {
  protocolVersion: z.literal(AWS_EGRESS_PROTOCOL_VERSION),
  generation: z.uuid(),
  stackId: awsStackIdSchema,
};
export const awsEgressSharedIdentitySchema = z
  .object({
    ...deploymentIdentity,
    secret: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type AwsEgressSharedIdentity = z.infer<typeof awsEgressSharedIdentitySchema>;

const sandboxIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

export const awsEc2EgressClaimsSchema = z
  .object({
    sandboxId: sandboxIdSchema,
    allocationId: z.uuid(),
    generation: deploymentIdentity.generation,
    stackId: deploymentIdentity.stackId,
    exp: z.number().int().positive(),
    type: z.literal('aws_ec2_egress'),
    aud: z.literal(AWS_EC2_EGRESS_AUDIENCE),
    instanceId: awsEc2InstanceIdSchema,
    build: z
      .object({
        environmentId: z.uuid(),
        buildId: z.uuid(),
        actorUserId: z.string().min(1).max(256),
        credentialId: z.uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AwsEc2EgressClaims = z.infer<typeof awsEc2EgressClaimsSchema>;
export const awsEc2HostLaunchSchema = z
  .object({
    instanceId: awsEc2InstanceIdSchema,
    dataVolumeId: awsEc2VolumeIdSchema,
    dataVolumeAction: z.enum(['initialize', 'restore', 'resume']),
    allocationId: z.uuid(),
    sandboxId: sandboxIdSchema,
    expiresAt: z.number().int().positive(),
    origin: z.url(),
    identity: awsEgressSharedIdentitySchema,
    token: z.string().min(1).max(4096),
  })
  .strict();
export type AwsEc2HostLaunch = z.infer<typeof awsEc2HostLaunchSchema>;
export const awsEgressPolicySchema = z
  .object({
    ...deploymentIdentity,
    sandboxId: sandboxIdSchema,
    allocationId: z.uuid(),
    allocationRef: z.string().min(1).max(512),
    validUntil: z.number().int().positive(),
    allowlist: z.array(egressDomainSchema).max(256).optional(),
    audit: z.boolean(),
    interceptedHosts: z.array(egressDomainSchema).max(32),
  })
  .strict();
export type AwsEgressPolicy = z.infer<typeof awsEgressPolicySchema>;
