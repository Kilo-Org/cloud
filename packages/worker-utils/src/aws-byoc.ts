import { z } from 'zod';
import { egressDomainSchema } from './egress-allowlist';

export const AWS_BYOC_TEMPLATE_VERSION = 2;
export const AWS_BYOC_PROXY_PROTOCOL_VERSION = 1;
export const AWS_BYOC_ENVELOPE_SCHEME = 'byoc-aws-configuration-rsa-aes-256-gcm';
export const AWS_BYOC_ENVELOPE_KEY_ID = 'agent-env-vars-v1';
export const AWS_MICROVM_MAXIMUM_DURATION_SECONDS = 28_800;

/** Each repository path segment is named; empty, `.` and `..` segments never name a repository. */
export function isAwsRepositoryPath(path: string): boolean {
  return path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export const awsProxyPinSchema = z
  .object({
    generation: z.uuid(),
    hostname: egressDomainSchema,
    caFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const awsByocConfigurationSchema = z
  .object({
    region: z.literal('us-east-1'),
    roleArn: z.string().regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/),
    externalId: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    stackId: z
      .string()
      .regex(/^arn:aws:cloudformation:us-east-1:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    imageIdentifier: z
      .string()
      .regex(/^arn:aws:lambda:us-east-1:\d{12}:microvm-image:[A-Za-z0-9_-]+$/),
    imageVersion: z.string().regex(/^\d+\.\d+$/),
    connectorArn: z
      .string()
      .regex(/^arn:aws:lambda:us-east-1:\d{12}:network-connector:[A-Za-z0-9_-]+:[1-9]\d*$/),
    templateVersion: z.number().int().nonnegative(),
    proxyProtocolVersion: z.number().int().positive(),
    // Older operation checkpoints remain readable for physical cleanup. New proxy launches require these pins.
    proxy: awsProxyPinSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const account = value.roleArn.split(':')[4];
    for (const key of ['stackId', 'imageIdentifier', 'connectorArn'] as const)
      if (value[key].split(':')[4] !== account)
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'AWS resources must belong to the selected customer account',
        });
  });

export type AwsByocConfiguration = z.infer<typeof awsByocConfigurationSchema>;
