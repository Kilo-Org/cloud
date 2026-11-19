import {
  AWS_BYOC_TEMPLATE_VERSION,
  AWS_BYOC_PROXY_PROTOCOL_VERSION,
  awsByocConfigurationSchema,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import {
  AWS_SETUP_ERRORS,
  type AwsSetupErrorCode,
  type AwsSetupIntent,
} from '@kilocode/worker-utils/aws-onboarding';

export class AwsSetupError extends Error {
  constructor(readonly code: AwsSetupErrorCode) {
    super(AWS_SETUP_ERRORS[code]);
    this.name = 'AwsSetupError';
  }
}
function complete(stack: AwsStack) {
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.status))
    throw new AwsSetupError('byoc_aws_stack_not_ready');
}
function version(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
export function assertAwsStackVersions(stack: AwsStack): void {
  const template = version(stack.outputs.TemplateVersion);
  if (template === null || template < AWS_BYOC_TEMPLATE_VERSION)
    throw new AwsSetupError('byoc_aws_stack_outdated');
  if (version(stack.outputs.ProxyProtocolVersion) !== AWS_BYOC_PROXY_PROTOCOL_VERSION)
    throw new AwsSetupError('byoc_aws_proxy_protocol_unsupported');
}
export function awsSetupParameters(intent: AwsSetupIntent): Record<string, string> {
  return {
    KiloRoleArn: intent.kiloRoleArn,
    ExternalId: intent.externalId,
    RuntimeArtifactBucket: intent.release.runtime.bucket,
    RuntimeArtifactKey: intent.release.runtime.key,
    RuntimeRepositoryArn: intent.release.runtime.repositoryArn,
    ProxyImageUri: intent.release.proxy.imageUri,
    ProxyRepositoryArn: intent.release.proxy.repositoryArn,
    ControlPlaneUrl: new URL(intent.controlPlaneUrl).origin,
  };
}

/** Initial Save proves the stack belongs to this intent and uses the approved release parameters. */
export function awsConfigurationFromSetupStack(input: {
  intent: AwsSetupIntent;
  roleArn: string;
  stack: AwsStack;
}): AwsByocConfiguration {
  const { intent, roleArn, stack } = input;
  complete(stack);
  assertAwsStackVersions(stack);
  if (
    roleArn.split(':')[4] !== intent.accountId ||
    stack.stackId.split(':')[4] !== intent.accountId ||
    stack.stackId.split(':')[3] !== 'us-east-1' ||
    stack.stackName !== intent.stackName ||
    stack.outputs.RoleArn !== roleArn ||
    version(stack.outputs.TemplateVersion) !== intent.release.templateVersion ||
    Object.entries(awsSetupParameters(intent)).some(
      ([key, value]) => stack.parameters[key] !== value
    )
  )
    throw new AwsSetupError('byoc_aws_stack_mismatch');
  const result = awsByocConfigurationSchema.safeParse({
    region: 'us-east-1',
    roleArn,
    externalId: intent.externalId,
    stackId: stack.stackId,
    bucket: stack.outputs.Bucket,
    imageIdentifier: stack.outputs.ImageArn,
    imageVersion: stack.outputs.ImageVersion,
    connectorArn: stack.outputs.ConnectorArn,
    templateVersion: version(stack.outputs.TemplateVersion),
    proxyProtocolVersion: version(stack.outputs.ProxyProtocolVersion),
  });
  if (!result.success) throw new AwsSetupError('byoc_aws_stack_mismatch');
  return result.data;
}

/** New allocations check the live minimum and exact persisted resources. Existing allocations keep their pins. */
export function assertAwsAllocationStack(
  stack: AwsStack,
  configuration: AwsByocConfiguration
): void {
  complete(stack);
  assertAwsStackVersions(stack);
  const expected: Record<string, string> = {
    RoleArn: configuration.roleArn,
    Bucket: configuration.bucket,
    ImageArn: configuration.imageIdentifier,
    ImageVersion: configuration.imageVersion,
    ConnectorArn: configuration.connectorArn,
    TemplateVersion: String(configuration.templateVersion),
    ProxyProtocolVersion: String(configuration.proxyProtocolVersion),
    ...(configuration.proxy ? { ProxyHostname: configuration.proxy.hostname } : {}),
  };
  if (
    stack.stackId !== configuration.stackId ||
    stack.stackId.split(':')[4] !== configuration.roleArn.split(':')[4] ||
    Object.entries(expected).some(([key, value]) => stack.outputs[key] !== value)
  )
    throw new AwsSetupError('byoc_aws_stack_mismatch');
}
