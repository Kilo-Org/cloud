import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
  awsByocConfigurationSchema,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import {
  AWS_BYOC_SETUP_ENVELOPE_SCHEME,
  awsByocReleaseSchema,
  awsSetupBindingSchema,
  awsSetupEnvelopeAad,
  awsSetupIntentSchema,
  type AwsSetupBinding,
  type AwsSetupIntent,
  type AwsSetupOwner,
} from '@kilocode/worker-utils/aws-onboarding';
import type { Env } from '../types.js';
import { byocOwnerKey, enrolledByocOwner } from './owner.js';
import { AwsSetupError } from './aws-stack-validation.js';

export type AwsSetupEnvironment = Pick<
  Env,
  | 'BYOC_AWS_IDS'
  | 'AWS_BYOC_CREDENTIALS'
  | 'AWS_BYOC_KILO_ROLE_ARN'
  | 'AWS_BYOC_RELEASE'
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

export function awsSetupEnrollment(env: AwsSetupEnvironment, owner: AwsSetupOwner) {
  const enrolled =
    enrolledByocOwner(env.BYOC_AWS_IDS, { userId: owner.userId, orgId: owner.organizationId }) !==
    undefined;
  let releaseValid = false;
  try {
    releaseValid = awsByocReleaseSchema.safeParse(JSON.parse(env.AWS_BYOC_RELEASE ?? '')).success;
  } catch {
    releaseValid = false;
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
  if (!awsSetupEnrollment(env, owner).enrolled)
    throw new AwsSetupError('byoc_aws_setup_unavailable');
}

/** The web service persists and seals this intent before it gives the customer a launch link. */
export function createAwsSetupIntent(
  env: AwsSetupEnvironment,
  binding: AwsSetupBinding,
  accountId: string
): AwsSetupIntent {
  awsSetupBindingSchema.parse(binding);
  requireAwsSetupEnrollment(env, binding.owner);
  let release;
  try {
    release = awsByocReleaseSchema.parse(JSON.parse(env.AWS_BYOC_RELEASE ?? ''));
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
  if (!release.customerAccounts.includes(accountId))
    throw new AwsSetupError('byoc_aws_account_not_enabled');
  let controlPlaneUrl: string;
  try {
    controlPlaneUrl = controlOrigin(env);
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const intent = awsSetupIntentSchema.safeParse({
    format: 1,
    accountId,
    stackName: `kilo-${binding.credentialId.replaceAll('-', '').toLowerCase()}`,
    externalId: Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''),
    kiloRoleArn: env.AWS_BYOC_KILO_ROLE_ARN,
    controlPlaneUrl,
    release,
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
): AwsSetupIntent {
  const key = privateKey(env);
  try {
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(envelope),
      AWS_BYOC_SETUP_ENVELOPE_SCHEME,
      { active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: key } },
      awsSetupEnvelopeAad(binding)
    );
    const intent = awsSetupIntentSchema.parse(JSON.parse(decoded));
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
): AwsByocConfiguration {
  const key = privateKey(env);
  try {
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(envelope),
      AWS_BYOC_ENVELOPE_SCHEME,
      { active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: key } },
      `byoc-aws-configuration:v1:${byocOwnerKey(binding.owner)}:${binding.credentialId}`
    );
    return awsByocConfigurationSchema.parse(JSON.parse(decoded));
  } catch {
    throw new AwsSetupError('byoc_aws_setup_unavailable');
  }
}
export function publicAwsConfiguration(configuration: AwsByocConfiguration) {
  return {
    accountId: configuration.roleArn.split(':')[4],
    roleArn: configuration.roleArn,
    stackId: configuration.stackId,
    region: configuration.region,
    templateVersion: configuration.templateVersion,
    proxyProtocolVersion: configuration.proxyProtocolVersion,
  };
}
