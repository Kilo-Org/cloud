import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  awsByocConfigurationSchema,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import { awsEcsByocConfigurationSchema } from '@kilocode/worker-utils/aws-ecs';
import {
  awsByocReleaseSchema,
  awsSetupBindingSchema,
  awsSetupIntentSchema,
  type AwsSetupBinding,
  type AwsSetupIntent,
  type AwsSetupOwner,
  type AwsSetupProvider,
} from '@kilocode/worker-utils/aws-onboarding';
import {
  awsEcsByocReleaseSchema,
  awsEcsSetupIntentSchema,
  awsProviderSetupEnvelope,
  awsProviderConfigurationEnvelope,
} from '@kilocode/worker-utils/aws-ecs-onboarding';
import type { Env } from '../types.js';
import { enrolledByocOwner } from './owner.js';
import { AwsSetupError } from './aws-stack-validation.js';

export type AwsSetupEnvironment = Pick<
  Env,
  | 'BYOC_AWS_IDS'
  | 'AWS_BYOC_CREDENTIALS'
  | 'AWS_BYOC_KILO_ROLE_ARN'
  | 'AWS_BYOC_RELEASE'
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
function release(env: AwsSetupEnvironment, provider: AwsSetupProvider) {
  switch (provider) {
    case 'aws':
      return awsByocReleaseSchema.parse(JSON.parse(env.AWS_BYOC_RELEASE ?? ''));
    case 'aws-ecs':
      return awsEcsByocReleaseSchema.parse(JSON.parse(env.AWS_ECS_BYOC_RELEASE ?? ''));
    default:
      throw new Error('Unsupported AWS provider');
  }
}
export function awsProviderSetupEnrollment(
  env: AwsSetupEnvironment,
  owner: AwsSetupOwner,
  provider: AwsSetupProvider
) {
  const enrolled =
    enrolledByocOwner(env.BYOC_AWS_IDS, { userId: owner.userId, orgId: owner.organizationId }) !==
    undefined;
  let releaseValid = false;
  try {
    release(env, provider);
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
export function awsSetupEnrollment(env: AwsSetupEnvironment, owner: AwsSetupOwner) {
  return awsProviderSetupEnrollment(env, owner, 'aws');
}
export function requireAwsSetupEnrollment(env: AwsSetupEnvironment, owner: AwsSetupOwner): void {
  if (
    enrolledByocOwner(env.BYOC_AWS_IDS, { userId: owner.userId, orgId: owner.organizationId }) ===
    undefined
  )
    throw new AwsSetupError('byoc_aws_setup_unavailable');
}
export function createAwsProviderSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  accountId: string,
  provider: AwsSetupProvider
) {
  awsSetupBindingSchema.parse(binding);
  requireAwsSetupEnrollment(env, binding.owner);
  let selected;
  try {
    selected = release(env, provider);
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
  const value = {
    format: 1,
    accountId,
    stackName: `kilo-${binding.credentialId.replaceAll('-', '').toLowerCase()}`,
    externalId: Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''),
    kiloRoleArn: env.AWS_BYOC_KILO_ROLE_ARN,
    controlPlaneUrl,
    release: selected,
  };
  const intent =
    provider === 'aws'
      ? awsSetupIntentSchema.safeParse(value)
      : awsEcsSetupIntentSchema.safeParse({ ...value, provider });
  if (!intent.success) throw new AwsSetupError('byoc_aws_setup_unavailable');
  return intent.data;
}
/** Existing callers always select MicroVM; an absent request provider is handled only at the API boundary. */
export function createAwsSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  accountId: string
): AwsSetupIntent {
  return awsSetupIntentSchema.parse(createAwsProviderSetupIntent(env, binding, accountId, 'aws'));
}
function privateKey(env: AwsSetupEnvironment): string {
  if (!env.AGENT_ENV_VARS_PRIVATE_KEY) throw new AwsSetupError('byoc_aws_setup_unavailable');
  return env.AGENT_ENV_VARS_PRIVATE_KEY;
}
export function readAwsProviderSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  envelope: unknown,
  provider: AwsSetupProvider
) {
  const key = privateKey(env);
  try {
    const purpose = awsProviderSetupEnvelope(provider, binding);
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(envelope),
      purpose.scheme,
      { active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: key } },
      purpose.aad
    );
    const value: unknown = JSON.parse(decoded);
    const intent =
      provider === 'aws' ? awsSetupIntentSchema.parse(value) : awsEcsSetupIntentSchema.parse(value);
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
export function readAwsSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  envelope: unknown
): AwsSetupIntent {
  return awsSetupIntentSchema.parse(readAwsProviderSetupIntent(env, binding, envelope, 'aws'));
}
export function readReadyAwsProviderConfiguration(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  envelope: unknown,
  provider: AwsSetupProvider
) {
  const key = privateKey(env);
  try {
    const purpose = awsProviderConfigurationEnvelope(provider, binding.owner, binding.credentialId);
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(envelope),
      purpose.scheme,
      { active: { keyId: purpose.keyId, privateKeyPem: key } },
      purpose.aad
    );
    const value: unknown = JSON.parse(decoded);
    return provider === 'aws'
      ? awsByocConfigurationSchema.parse(value)
      : awsEcsByocConfigurationSchema.parse(value);
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
}
export function readReadyAwsConfiguration(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  envelope: unknown
): AwsByocConfiguration {
  return awsByocConfigurationSchema.parse(
    readReadyAwsProviderConfiguration(env, binding, envelope, 'aws')
  );
}
