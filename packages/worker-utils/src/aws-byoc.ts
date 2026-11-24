import { z } from 'zod';
import { egressDomainSchema } from './egress-allowlist';

/** Shared AWS BYOC primitives. `aws-ecs.ts` owns the provider configuration. */
export const AWS_BYOC_PROXY_PROTOCOL_VERSION = 1;
export const AWS_BYOC_ENVELOPE_KEY_ID = 'agent-env-vars-v1';
/** A new allocation needs this much remaining proxy certificate validity. */
export const AWS_PROXY_CERTIFICATE_RESERVE_SECONDS = 28_800;

/** Each repository path segment is named; empty, `.` and `..` segments never name a repository. */
export function isAwsRepositoryPath(path: string): boolean {
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export const awsRegionSchema = z.literal('us-east-1');
export const awsRoleArnSchema = z
  .string()
  .regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/);
export const awsExternalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const awsStackIdSchema = z
  .string()
  .regex(/^arn:aws:cloudformation:us-east-1:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/);
export const awsBucketSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
export const awsTemplateVersionSchema = z.number().int().nonnegative();
export const awsProxyProtocolVersionSchema = z.number().int().positive();

export const awsProxyPinSchema = z
  .object({
    generation: z.uuid(),
    hostname: egressDomainSchema,
    caFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
