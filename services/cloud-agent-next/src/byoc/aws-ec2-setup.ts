import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  awsEc2ByocReleaseSchema,
  awsEc2ConfigurationEnvelope,
  awsEc2SetupEnvelope,
  awsEc2SetupIntentSchema,
  type AwsEc2SetupIntent,
  type AwsSetupBinding,
  type AwsSetupOwner,
} from '@kilocode/worker-utils/aws-onboarding';
import {
  awsEc2ByocConfigurationSchema,
  type AwsEc2ByocConfiguration,
} from '@kilocode/worker-utils/aws-ec2';
import { createAwsEc2Client } from '@kilocode/worker-utils/aws-ec2-client';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import type { Env } from '../types.js';
import { generateSandboxCredential } from '../sandbox-control/credential.js';
import { isApprovedAwsEc2Image, validateAwsEc2Stack } from './aws-ec2-stack.js';
import { enrolledByocOwner } from './owner.js';
import { createAwsSetupService } from './aws-setup-service.js';
import { AwsSetupError } from './aws-errors.js';

function requireAwsSetupEnrollment(env: Env, owner: AwsSetupOwner): void {
  if (
    enrolledByocOwner(env.BYOC_AWS_IDS, { userId: owner.userId, orgId: owner.organizationId }) ===
    undefined
  )
    throw new AwsSetupError('byoc_aws_setup_unavailable');
}

function release(env: Env) {
  const selected = awsEc2ByocReleaseSchema.parse(JSON.parse(env.AWS_EC2_BYOC_RELEASE ?? ''));
  if (!isApprovedAwsEc2Image(env.AWS_EC2_HOST_AMI_IDS, selected.imageId))
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  return selected;
}

export function awsEc2SetupEnrollment(env: Env, owner: AwsSetupOwner) {
  try {
    requireAwsSetupEnrollment(env, owner);
  } catch {
    return { enrolled: false, available: false };
  }
  try {
    release(env);
    return {
      enrolled: true,
      available: Boolean(
        env.AWS_BYOC_CREDENTIALS && env.AWS_BYOC_KILO_ROLE_ARN && env.AGENT_ENV_VARS_PRIVATE_KEY
      ),
    };
  } catch {
    return { enrolled: true, available: false };
  }
}

function setupStackName(binding: AwsSetupBinding): string {
  return `kilo-${binding.credentialId.replaceAll('-', '').toLowerCase()}`;
}

export function createAwsEc2SetupIntent(env: Env, binding: AwsSetupBinding, accountId: string) {
  requireAwsSetupEnrollment(env, binding.owner);
  const selected = release(env);
  if (!selected.customerAccounts.includes(accountId))
    throw new AwsSetupError('byoc_aws_account_not_enabled');
  return awsEc2SetupIntentSchema.parse({
    format: 1,
    provider: 'aws-ec2',
    accountId,
    stackName: setupStackName(binding),
    externalId: generateSandboxCredential(),
    kiloRoleArn: env.AWS_BYOC_KILO_ROLE_ARN,
    installation: binding.generation,
    release: selected,
  });
}

function parameters(intent: AwsEc2SetupIntent) {
  return {
    KiloRoleArn: intent.kiloRoleArn,
    ExternalId: intent.externalId,
    InstallationId: intent.installation,
    HostAmiId: intent.release.imageId,
  };
}

export function awsEc2ResourcesFromSetupStack(
  intent: AwsEc2SetupIntent,
  roleArn: string,
  stack: AwsStack
) {
  if (!['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.status))
    throw new AwsSetupError('byoc_aws_stack_not_ready');
  const pinned = parameters(intent);
  if (
    stack.stackName !== intent.stackName ||
    stack.stackId.split(':')[4] !== intent.accountId ||
    stack.parameters.KiloRoleArn !== pinned.KiloRoleArn ||
    stack.parameters.HostAmiId !== pinned.HostAmiId ||
    stack.parameters.InstallationId !== pinned.InstallationId ||
    stack.outputs.Provider !== 'aws-ec2' ||
    stack.outputs.ControllerRoleArn !== roleArn ||
    stack.outputs.InstallationId !== pinned.InstallationId ||
    stack.outputs.HostAmiId !== pinned.HostAmiId
  )
    throw new AwsSetupError('byoc_aws_stack_mismatch');
  if (stack.outputs.TemplateVersion !== String(intent.release.templateVersion))
    throw new AwsSetupError('byoc_aws_stack_outdated');
  const result = awsEc2ByocConfigurationSchema.safeParse({
    region: 'us-east-1',
    roleArn,
    externalId: intent.externalId,
    stackId: stack.stackId,
    bucket: stack.outputs.ArtifactBucket,
    templateVersion: intent.release.templateVersion,
    subnetId: stack.outputs.PrivateSubnetId,
    securityGroupId: stack.outputs.HostSecurityGroupId,
    imageId: pinned.HostAmiId,
    instanceProfileArn: stack.outputs.HostInstanceProfileArn,
    launchTemplateId: stack.outputs.LaunchTemplateId,
    launchTemplateVersion: Number(stack.outputs.LaunchTemplateVersion),
    installation: pinned.InstallationId,
  });
  if (!result.success) throw new AwsSetupError('byoc_aws_stack_mismatch');
  return result.data;
}

export function createAwsEc2SetupService(env: Env) {
  const transport = createAwsSetupService(env);
  function read(envelope: unknown, purpose: ReturnType<typeof awsEc2SetupEnvelope>): unknown {
    if (!env.AGENT_ENV_VARS_PRIVATE_KEY) throw new AwsSetupError('byoc_aws_setup_unavailable');
    return JSON.parse(
      decryptKeyedEnvelope(
        JSON.stringify(envelope),
        purpose.scheme,
        {
          active: { keyId: purpose.keyId, privateKeyPem: env.AGENT_ENV_VARS_PRIVATE_KEY },
        },
        purpose.aad
      )
    );
  }
  function draft(binding: AwsSetupBinding, envelope: unknown): AwsEc2SetupIntent {
    requireAwsSetupEnrollment(env, binding.owner);
    try {
      const intent = awsEc2SetupIntentSchema.parse(read(envelope, awsEc2SetupEnvelope(binding)));
      if (
        intent.stackName === setupStackName(binding) &&
        intent.installation === binding.generation &&
        intent.kiloRoleArn === env.AWS_BYOC_KILO_ROLE_ARN &&
        isApprovedAwsEc2Image(env.AWS_EC2_HOST_AMI_IDS, intent.release.imageId)
      )
        return intent;
    } catch {
      /* Fixed error for invalid or changed draft. */
    }
    throw new AwsSetupError('byoc_aws_setup_changed');
  }
  async function verify(
    config: AwsEc2ByocConfiguration,
    stack: AwsStack,
    credentials: Awaited<ReturnType<typeof transport.customer>>
  ) {
    const client = createAwsEc2Client({ credentials, region: config.region });
    try {
      await validateAwsEc2Stack({
        config,
        approvedImages: env.AWS_EC2_HOST_AMI_IDS,
        read: async () => stack,
        validateTemplate: signal => client.validateLaunchTemplate(config, signal),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'byoc_aws_connection_changed')
        throw new AwsSetupError('byoc_aws_stack_mismatch');
      throw new AwsSetupError('byoc_aws_stack_unavailable');
    }
  }
  return {
    async instructions(binding: AwsSetupBinding, envelope: unknown) {
      const intent = draft(binding, envelope);
      const { url, expiresAt } = await transport.signedTemplate(
        intent.release.template,
        AbortSignal.timeout(30_000)
      );
      const query = new URLSearchParams({ templateURL: url, stackName: intent.stackName });
      for (const [name, value] of Object.entries(parameters(intent)))
        query.set(`param_${name}`, value);
      return {
        launchUrl: `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?${query.toString()}`,
        accountId: intent.accountId,
        stackName: intent.stackName,
        templateVersion: intent.release.templateVersion,
        expiresAt,
      };
    },
    async validate(binding: AwsSetupBinding, envelope: unknown, roleArn: string) {
      const intent = draft(binding, envelope);
      if (roleArn.split(':')[4] !== intent.accountId)
        throw new AwsSetupError('byoc_aws_stack_mismatch');
      const signal = AbortSignal.timeout(45_000);
      const credentials = await transport.customer(roleArn, intent.externalId, signal);
      const stack = await transport.stack(credentials, intent.stackName, signal);
      const config = awsEc2ResourcesFromSetupStack(intent, roleArn, stack);
      await verify(config, stack, credentials);
      return config;
    },
    async revalidate(binding: AwsSetupBinding, envelope: unknown, roleArn: string) {
      requireAwsSetupEnrollment(env, binding.owner);
      const config = awsEc2ByocConfigurationSchema.parse(
        read(envelope, awsEc2ConfigurationEnvelope(binding.owner, binding.credentialId))
      );
      if (roleArn !== config.roleArn) throw new AwsSetupError('byoc_aws_stack_mismatch');
      const signal = AbortSignal.timeout(45_000);
      const credentials = await transport.customer(roleArn, config.externalId, signal);
      const stack = await transport.stack(credentials, config.stackId, signal);
      await verify(config, stack, credentials);
    },
  };
}
