import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import {
  AWS_ECS_BYOC_ENVELOPE_SCHEME,
  AWS_ECS_BYOC_TEMPLATE_VERSION,
  awsEcsByocConfigurationSchema,
} from '@kilocode/worker-utils/aws-ecs';
import { createEcsClient } from '../agent-sandbox/aws/ecs-client.js';
import type { Env } from '../types.js';
import { byocOwnerKey, type ByocSource } from './owner.js';
import { fetchAwsProviderConnection } from './aws-credential-resolver.js';
import { ByocAwsProviderError } from './aws-errors.js';
import { awsAccountAccess } from './aws-account-access.js';
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';

/** ECS never reads a MicroVM connection or accepts its encryption purpose. */
export async function resolveAwsEcsByocConfiguration(env: Env, source: ByocSource) {
  const connection = await fetchAwsProviderConnection(env, source, 'aws-ecs', source.credentialId);
  if (connection.setupStatus !== 'ready' || !env.AGENT_ENV_VARS_PRIVATE_KEY)
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  let configuration: AwsEcsByocConfiguration;
  try {
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(connection.credentialsEncrypted),
      AWS_ECS_BYOC_ENVELOPE_SCHEME,
      {
        active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: env.AGENT_ENV_VARS_PRIVATE_KEY },
      },
      `byoc-aws-ecs-configuration:v1:${byocOwnerKey(source)}:${source.credentialId}`
    );
    configuration = awsEcsByocConfigurationSchema.parse(JSON.parse(decoded));
  } catch {
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  }
  if (configuration.templateVersion < AWS_ECS_BYOC_TEMPLATE_VERSION)
    throw new ByocAwsProviderError('byoc_aws_stack_outdated');
  return configuration;
}
export async function awsEcsRuntimeAccess(env: Env, configuration: AwsEcsByocConfiguration) {
  const { credentials, ...access } = await awsAccountAccess(env, configuration);
  return { ...access, client: createEcsClient({ credentials, region: configuration.region }) };
}
