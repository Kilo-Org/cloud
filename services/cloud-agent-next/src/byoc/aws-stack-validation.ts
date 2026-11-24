import { AWS_BYOC_PROXY_PROTOCOL_VERSION } from '@kilocode/worker-utils/aws-byoc';
import {
  awsEcsResourceConfigurationSchema,
  AWS_ECS_BYOC_TEMPLATE_VERSION,
  type AwsEcsByocConfiguration,
} from '@kilocode/worker-utils/aws-ecs';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import {
  AWS_SETUP_ERRORS,
  type AwsEcsSetupIntent,
  type AwsSetupErrorCode,
} from '@kilocode/worker-utils/aws-onboarding';

export class AwsSetupError extends Error {
  constructor(readonly code: AwsSetupErrorCode) {
    super(AWS_SETUP_ERRORS[code]);
    this.name = 'AwsSetupError';
  }
}
function assertAwsStackComplete(stack: AwsStack) {
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.status))
    throw new AwsSetupError('byoc_aws_stack_not_ready');
}
function version(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
export function assertAwsStackVersions(stack: AwsStack, minimumTemplateVersion: number): void {
  const template = version(stack.outputs.TemplateVersion);
  if (template === null || template < minimumTemplateVersion)
    throw new AwsSetupError('byoc_aws_stack_outdated');
  if (version(stack.outputs.ProxyProtocolVersion) !== AWS_BYOC_PROXY_PROTOCOL_VERSION)
    throw new AwsSetupError('byoc_aws_proxy_protocol_unsupported');
}
export function awsEcsSetupParameters(intent: AwsEcsSetupIntent): Record<string, string> {
  return {
    KiloRoleArn: intent.kiloRoleArn,
    ExternalId: intent.externalId,
    RuntimeRepositoryArn: intent.release.runtime.repositoryArn,
    ProxyImageUri: intent.release.proxy.imageUri,
    ProxyRepositoryArn: intent.release.proxy.repositoryArn,
    ControlPlaneUrl: new URL(intent.controlPlaneUrl).origin,
    RuntimeImageUri: intent.release.runtime.imageUri,
  };
}
function assertAwsSetupStackBinding(input: {
  intent: AwsEcsSetupIntent;
  roleArn: string;
  stack: AwsStack;
  parameters: Record<string, string>;
}): void {
  const { intent, roleArn, stack, parameters } = input;
  assertAwsStackComplete(stack);
  assertAwsStackVersions(stack, intent.release.templateVersion);
  if (
    roleArn.split(':')[4] !== intent.accountId ||
    stack.stackId.split(':')[4] !== intent.accountId ||
    stack.stackId.split(':')[3] !== 'us-east-1' ||
    stack.stackName !== intent.stackName ||
    stack.outputs.RoleArn !== roleArn ||
    version(stack.outputs.TemplateVersion) !== intent.release.templateVersion ||
    Object.entries(parameters).some(([key, value]) => stack.parameters[key] !== value)
  )
    throw new AwsSetupError('byoc_aws_stack_mismatch');
}

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
