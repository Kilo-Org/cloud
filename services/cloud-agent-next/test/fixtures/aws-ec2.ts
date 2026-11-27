import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';

export const EC2_TEST_CONFIG: AwsEc2ByocConfiguration = {
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/controller',
  externalId: 'a'.repeat(64),
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/12345678-abcd',
  bucket: 'customer-artifacts',
  templateVersion: 1,
  subnetId: 'subnet-0123456789abcdef0',
  securityGroupId: 'sg-0123456789abcdef0',
  imageId: 'ami-0123456789abcdef0',
  instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/host',
  launchTemplateId: 'lt-0123456789abcdef0',
  launchTemplateVersion: 1,
  installation: '22222222-2222-4222-8222-222222222222',
};
