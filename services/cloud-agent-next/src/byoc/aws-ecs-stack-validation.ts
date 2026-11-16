import {
  awsEcsResourceConfigurationSchema,
  AWS_ECS_BYOC_TEMPLATE_VERSION,
  type AwsEcsByocConfiguration,
} from '@kilocode/worker-utils/aws-ecs';
import type { AwsEcsSetupIntent } from '@kilocode/worker-utils/aws-ecs-onboarding';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import {
  AwsSetupError,
  assertAwsSetupStackBinding,
  awsEcsSetupParameters,
  assertAwsStackComplete,
  assertAwsStackVersions,
} from './aws-stack-validation.js';

/** New ECS allocations must use the exact ready stack and resource revision. */
export function assertAwsEcsAllocationStack(
  stack: AwsStack,
  config: AwsEcsByocConfiguration
): void {
  assertAwsStackComplete(stack);
  assertAwsStackVersions(stack, AWS_ECS_BYOC_TEMPLATE_VERSION);
  const expected = {
    Provider: 'aws-ecs',
    RoleArn: config.roleArn,
    Bucket: config.bucket,
    ClusterArn: config.clusterArn,
    TaskDefinitionArn: config.taskDefinitionArn,
    CapacityProvider: config.capacityProvider,
    ExecutionRoleArn: config.executionRoleArn,
    RuntimeImage: config.runtimeImage,
    PrivateSubnet: config.subnetId,
    SandboxSecurityGroup: config.securityGroupId,
    ProxyHostname: config.proxy.hostname,
    TemplateVersion: String(config.templateVersion),
    ProxyProtocolVersion: String(config.proxyProtocolVersion),
  };
  if (
    stack.stackId !== config.stackId ||
    stack.stackId.split(':')[4] !== config.roleArn.split(':')[4] ||
    Object.entries(expected).some(([key, value]) => stack.outputs[key] !== value)
  )
    throw new AwsSetupError('byoc_aws_stack_mismatch');
}

/** Validate every ECS identity before using its bucket for proxy metadata. */
export function awsEcsResourcesFromSetupStack(input: {
  intent: AwsEcsSetupIntent;
  roleArn: string;
  stack: AwsStack;
}) {
  const { intent, roleArn, stack } = input;
  assertAwsSetupStackBinding({ ...input, parameters: awsEcsSetupParameters(intent) });
  if (
    stack.outputs.Provider !== 'aws-ecs' ||
    stack.outputs.RuntimeImage !== intent.release.runtime.imageUri
  )
    throw new AwsSetupError('byoc_aws_stack_mismatch');
  const result = awsEcsResourceConfigurationSchema.safeParse({
    region: 'us-east-1',
    roleArn,
    externalId: intent.externalId,
    stackId: stack.stackId,
    bucket: stack.outputs.Bucket,
    templateVersion: Number(stack.outputs.TemplateVersion),
    proxyProtocolVersion: Number(stack.outputs.ProxyProtocolVersion),
    clusterArn: stack.outputs.ClusterArn,
    taskDefinitionArn: stack.outputs.TaskDefinitionArn,
    capacityProvider: stack.outputs.CapacityProvider,
    subnetId: stack.outputs.PrivateSubnet,
    securityGroupId: stack.outputs.SandboxSecurityGroup,
    executionRoleArn: stack.outputs.ExecutionRoleArn,
    runtimeImage: stack.outputs.RuntimeImage,
  });
  if (!result.success) throw new AwsSetupError('byoc_aws_stack_mismatch');
  return result.data;
}
