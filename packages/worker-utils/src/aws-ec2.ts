import { z } from 'zod';
import {
  awsBucketSchema,
  awsExternalIdSchema,
  awsRegionSchema,
  awsRoleArnSchema,
  awsStackIdSchema,
} from './aws-byoc';

export const AWS_EC2_DATA_DEVICE = '/dev/sdf';
export const AWS_EC2_INSTANCE_TYPE = 'm7i.large';
export const AWS_EC2_STACK_VERSION = 1;
export const AWS_EC2_BYOC_ENVELOPE_SCHEME = 'byoc-aws-ec2-configuration-rsa-aes-256-gcm';
export const AWS_EC2_TAGS = {
  installation: 'KiloInstallation',
  generation: 'KiloSandboxGeneration',
  allocation: 'KiloAllocation',
  capture: 'KiloSnapshotCapture',
} as const;

const resourceId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}-(?:[a-f0-9]{8}|[a-f0-9]{17})$`));

export const awsEc2InstanceIdSchema = resourceId('i');
export const awsEc2VolumeIdSchema = resourceId('vol');
export const awsEc2SnapshotIdSchema = resourceId('snap');
export const awsEc2ImageIdSchema = resourceId('ami');
export const awsEc2SubnetIdSchema = resourceId('subnet');
export const awsEc2SecurityGroupIdSchema = resourceId('sg');
export const awsEc2LaunchTemplateIdSchema = resourceId('lt');
export const awsEc2NetworkInterfaceIdSchema = resourceId('eni');
export const awsEc2AccountIdSchema = z.string().regex(/^\d{12}$/);
export const awsEc2InstanceProfileArnSchema = z
  .string()
  .regex(/^arn:aws:iam::\d{12}:instance-profile\/[A-Za-z0-9+=,.@_/-]+$/);

export const awsEc2ByocConfigurationSchema = z
  .object({
    region: awsRegionSchema,
    roleArn: awsRoleArnSchema,
    externalId: awsExternalIdSchema,
    stackId: awsStackIdSchema,
    bucket: awsBucketSchema,
    templateVersion: z.literal(AWS_EC2_STACK_VERSION),
    subnetId: awsEc2SubnetIdSchema,
    securityGroupId: awsEc2SecurityGroupIdSchema,
    imageId: awsEc2ImageIdSchema,
    instanceProfileArn: awsEc2InstanceProfileArnSchema,
    launchTemplateId: awsEc2LaunchTemplateIdSchema,
    launchTemplateVersion: z.number().int().positive(),
    installation: z.uuid(),
  })
  .strict()
  .refine(
    config => {
      const account = config.roleArn.split(':')[4];
      return (
        config.stackId.split(':')[4] === account &&
        config.instanceProfileArn.split(':')[4] === account
      );
    },
    { message: 'EC2 resources must belong to the customer account' }
  );
export type AwsEc2ByocConfiguration = z.infer<typeof awsEc2ByocConfigurationSchema>;
