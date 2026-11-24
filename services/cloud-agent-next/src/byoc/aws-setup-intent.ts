import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import {
  awsEcsByocConfigurationSchema,
  type AwsEcsByocConfiguration,
} from '@kilocode/worker-utils/aws-ecs';
import {
  awsEcsByocReleaseSchema,
  awsEcsConfigurationEnvelope,
  awsEcsSetupEnvelope,
  awsEcsSetupIntentSchema,
  awsSetupBindingSchema,
  type AwsEcsSetupIntent,
  type AwsSetupBinding,
  type AwsSetupOwner,
} from '@kilocode/worker-utils/aws-onboarding';
import type { Env } from '../types.js';
import { enrolledByocOwner } from './owner.js';
import { AwsSetupError } from './aws-stack-validation.js';

export type AwsSetupEnvironment = Pick<
  Env,
  | 'BYOC_AWS_IDS'
  | 'AWS_BYOC_CREDENTIALS'
  | 'AWS_BYOC_KILO_ROLE_ARN'
  | 'AWS_ECS_BYOC_RELEASE'
  | 'AGENT_ENV_VARS_PRIVATE_KEY'
  | 'WORKER_URL'
>;
function controlOrigin(env: AwsSetupEnvironment): string {
  const url = new URL(env.WORKER_URL ?? '');
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid AWS control origin');
  return url.origin;
}
function release(env: AwsSetupEnvironment) {
  return awsEcsByocReleaseSchema.parse(JSON.parse(env.AWS_ECS_BYOC_RELEASE ?? ''));
}
export function awsSetupEnrollment(env: AwsSetupEnvironment, owner: AwsSetupOwner) {
  const enrolled =
    enrolledByocOwner(env.BYOC_AWS_IDS, { userId: owner.userId, orgId: owner.organizationId }) !==
    undefined;
  let releaseValid = false;
  try {
    release(env);
    releaseValid = true;
  } catch {
    /* Missing operator release is unavailable at point of use. */
  }
  return {
    enrolled,
    available:
      enrolled &&
      releaseValid &&
      Boolean(
        env.AWS_BYOC_CREDENTIALS && env.AWS_BYOC_KILO_ROLE_ARN && env.AGENT_ENV_VARS_PRIVATE_KEY
      ),
  };
}
export function requireAwsSetupEnrollment(env: AwsSetupEnvironment, owner: AwsSetupOwner): void {
  if (
    enrolledByocOwner(env.BYOC_AWS_IDS, { userId: owner.userId, orgId: owner.organizationId }) ===
    undefined
  )
    throw new AwsSetupError('byoc_aws_setup_unavailable');
}
export function createAwsSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  accountId: string
): AwsEcsSetupIntent {
  awsSetupBindingSchema.parse(binding);
  requireAwsSetupEnrollment(env, binding.owner);
  let selected;
  try {
    selected = release(env);
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
  if (!selected.customerAccounts.includes(accountId))
    throw new AwsSetupError('byoc_aws_account_not_enabled');
  let controlPlaneUrl: string;
  try {
    controlPlaneUrl = controlOrigin(env);
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const intent = awsEcsSetupIntentSchema.safeParse({
    format: 1,
    provider: 'aws-ecs',
    accountId,
    stackName: `kilo-${binding.credentialId.replaceAll('-', '').toLowerCase()}`,
    externalId: Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''),
    kiloRoleArn: env.AWS_BYOC_KILO_ROLE_ARN,
    controlPlaneUrl,
    release: selected,
  });
  if (!intent.success) throw new AwsSetupError('byoc_aws_setup_unavailable');
  return intent.data;
}
function privateKey(env: AwsSetupEnvironment): string {
  if (!env.AGENT_ENV_VARS_PRIVATE_KEY) throw new AwsSetupError('byoc_aws_setup_unavailable');
  return env.AGENT_ENV_VARS_PRIVATE_KEY;
}
export function readAwsSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  envelope: unknown
): AwsEcsSetupIntent {
  const key = privateKey(env);
  try {
    const purpose = awsEcsSetupEnvelope(binding);
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(envelope),
      purpose.scheme,
      { active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: key } },
      purpose.aad
    );
    const intent = awsEcsSetupIntentSchema.parse(JSON.parse(decoded));
    if (
      intent.stackName !== `kilo-${binding.credentialId.replaceAll('-', '').toLowerCase()}` ||
      intent.kiloRoleArn !== env.AWS_BYOC_KILO_ROLE_ARN ||
      intent.controlPlaneUrl !== controlOrigin(env)
    )
      throw new Error('Setup binding changed');
    return intent;
  } catch {
    throw new AwsSetupError('byoc_aws_setup_changed');
  }
}
export function readReadyAwsConfiguration(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  envelope: unknown
): AwsEcsByocConfiguration {
  const key = privateKey(env);
  try {
    const purpose = awsEcsConfigurationEnvelope(binding.owner, binding.credentialId);
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(envelope),
      purpose.scheme,
      { active: { keyId: purpose.keyId, privateKeyPem: key } },
      purpose.aad
    );
    return awsEcsByocConfigurationSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
}
