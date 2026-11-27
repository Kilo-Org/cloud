import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import {
  AWS_EC2_STACK_VERSION,
  type AwsEc2ByocConfiguration,
} from '@kilocode/worker-utils/aws-ec2';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import { ByocAwsProviderError } from './aws-errors.js';

export function assertAwsEc2Stack(stack: AwsStack, config: AwsEc2ByocConfiguration) {
  if (stack.status.endsWith('_IN_PROGRESS'))
    throw new ByocAwsProviderError('byoc_aws_stack_unavailable');
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.status))
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  if (
    stack.outputs.Provider !== 'aws-ec2' ||
    stack.outputs.TemplateVersion !== String(AWS_EC2_STACK_VERSION)
  )
    throw new ByocAwsProviderError('byoc_aws_stack_outdated');
  const expected = {
    InstallationId: config.installation,
    ControllerRoleArn: config.roleArn,
    ArtifactBucket: config.bucket,
    PrivateSubnetId: config.subnetId,
    HostSecurityGroupId: config.securityGroupId,
    HostAmiId: config.imageId,
    HostInstanceProfileArn: config.instanceProfileArn,
    LaunchTemplateId: config.launchTemplateId,
    LaunchTemplateVersion: String(config.launchTemplateVersion),
  };
  if (
    stack.stackId !== config.stackId ||
    Object.entries(expected).some(([key, value]) => stack.outputs[key] !== value)
  )
    throw new ByocAwsProviderError('byoc_aws_connection_changed');
}

export function isApprovedAwsEc2Image(
  approvedImages: string | undefined,
  imageId: string
): boolean {
  return approvedImages?.split(',').some(image => image.trim() === imageId) === true;
}

export async function validateAwsEc2Stack(input: {
  config: AwsEc2ByocConfiguration;
  approvedImages: string | undefined;
  read(signal: AbortSignal): Promise<AwsStack>;
  validateTemplate(signal: AbortSignal): Promise<void>;
}) {
  const { config } = input;
  if (!isApprovedAwsEc2Image(input.approvedImages, config.imageId))
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  const signal = AbortSignal.timeout(8000);
  try {
    assertAwsEc2Stack(await input.read(signal), config);
    await input.validateTemplate(signal);
  } catch (error) {
    if (!(error instanceof AwsRequestError)) throw error;
    if (error.status === 403) throw new ByocAwsProviderError('byoc_aws_forbidden');
    if (error.status === 422) throw new ByocAwsProviderError('byoc_aws_connection_changed');
    throw new ByocAwsProviderError('byoc_aws_stack_unavailable');
  }
}
