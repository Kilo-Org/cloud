import { z } from 'zod';
import {
  awsBucketSchema,
  awsExternalIdSchema,
  awsProxyPinSchema,
  awsProxyProtocolVersionSchema,
  awsRegionSchema,
  awsRoleArnSchema,
  awsStackIdSchema,
  awsTemplateVersionSchema,
  isAwsRepositoryPath,
} from './aws-byoc';

export const AWS_ECS_BYOC_TEMPLATE_VERSION = 1;
export const AWS_ECS_BYOC_ENVELOPE_SCHEME = 'byoc-aws-ecs-configuration-rsa-aes-256-gcm';
const clusterArn = z.string().regex(/^arn:aws:ecs:us-east-1:\d{12}:cluster\/[A-Za-z0-9_-]{1,255}$/);
const taskDefinitionArn = z
  .string()
  .regex(/^arn:aws:ecs:us-east-1:\d{12}:task-definition\/[A-Za-z0-9_-]{1,255}:[1-9]\d*$/);
export const awsEcsTaskArnSchema = z
  .string()
  .regex(/^arn:aws:ecs:us-east-1:\d{12}:task\/[A-Za-z0-9_-]{1,255}\/[a-f0-9]{32}$/);

/** The customer stack resources that an ECS allocation uses. */
export const awsEcsResourceConfigurationSchema = z
  .object({
    region: awsRegionSchema,
    roleArn: awsRoleArnSchema,
    externalId: awsExternalIdSchema,
    stackId: awsStackIdSchema,
    bucket: awsBucketSchema,
    templateVersion: awsTemplateVersionSchema,
    proxyProtocolVersion: awsProxyProtocolVersionSchema,
    clusterArn,
    taskDefinitionArn,
    capacityProvider: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/),
    subnetId: z.string().regex(/^subnet-(?:[a-f0-9]{8}|[a-f0-9]{17})$/),
    securityGroupId: z.string().regex(/^sg-(?:[a-f0-9]{8}|[a-f0-9]{17})$/),
    executionRoleArn: awsRoleArnSchema,
    runtimeImage: z
      .string()
      .regex(
        /^\d{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const account = value.roleArn.split(':')[4];
    for (const field of [
      'stackId',
      'clusterArn',
      'taskDefinitionArn',
      'executionRoleArn',
    ] as const) {
      if (value[field].split(':')[4] !== account)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'ECS resources must belong to the customer account',
        });
    }
    const repository = value.runtimeImage
      .replace(/^\d{12}\.dkr\.ecr\.us-east-1\.amazonaws\.com\//, '')
      .split('@')[0];
    if (!repository || !isAwsRepositoryPath(repository)) {
      context.addIssue({
        code: 'custom',
        path: ['runtimeImage'],
        message: 'Invalid runtime repository',
      });
    }
  });
export const awsEcsByocConfigurationSchema = awsEcsResourceConfigurationSchema.safeExtend({
  proxy: awsProxyPinSchema,
});
export type AwsEcsResourceConfiguration = z.infer<typeof awsEcsResourceConfigurationSchema>;
export type AwsEcsByocConfiguration = z.infer<typeof awsEcsByocConfigurationSchema>;
