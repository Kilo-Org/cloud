import { ByocAwsProviderError } from './aws-errors.js';
import { awsAccountAccess } from './aws-account-access.js';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { readAwsResponse } from '@kilocode/worker-utils/aws-client';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import {
  AWS_ECS_BYOC_ENVELOPE_SCHEME,
  AWS_ECS_BYOC_TEMPLATE_VERSION,
  awsEcsByocConfigurationSchema,
  type AwsEcsByocConfiguration,
} from '@kilocode/worker-utils/aws-ecs';
import { z } from 'zod';
import { byocOwnerKey, byocOwnerSchema, type ByocOwner, type ByocSource } from './owner.js';
import type { Env } from '../types.js';
import { createEcsClient } from '../agent-sandbox/aws/ecs-client.js';
import { logger } from '../logger.js';

export { ByocAwsProviderError } from './aws-errors.js';
export { assumeAwsKiloRole } from './aws-account-access.js';

const connectionSchema = z
  .object({
    credentialId: z.uuid(),
    setupStatus: z.enum(['pending', 'building', 'ready', 'failed']),
    credentialsEncrypted: z.unknown(),
  })
  .and(byocOwnerSchema);

const PROVIDER = 'aws-ecs';

function lookupFailure(
  stage: 'configuration' | 'internal_auth' | 'request' | 'response' | 'contract',
  status?: number
) {
  logger
    .withFields({
      provider: PROVIDER,
      stage,
      ...(status === undefined ? {} : { httpStatus: status }),
    })
    .warn('AWS BYOC connection lookup failed');
  return new ByocAwsProviderError('byoc_aws_not_ready');
}

export async function fetchAwsByocConnection(env: Env, owner: ByocOwner, credentialId?: string) {
  const base = env.KILOCODE_BACKEND_BASE_URL?.replace(/\/+$/, '');
  if (!base) throw lookupFailure('configuration');
  const query = new URLSearchParams({
    provider: PROVIDER,
    ...(owner.organizationId !== undefined
      ? { organizationId: owner.organizationId }
      : { userId: owner.userId }),
    ...(credentialId ? { credentialId } : {}),
  });
  let response: Response;
  let secret: string;
  try {
    secret = await env.INTERNAL_API_SECRET_PROD.get();
    if (!secret) throw new Error('missing internal authentication');
  } catch {
    throw lookupFailure('internal_auth');
  }
  try {
    response = await fetch(`${base}/api/internal/byoc/connections?${query.toString()}`, {
      headers: { 'x-internal-api-key': secret },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    });
  } catch {
    throw lookupFailure('request');
  }
  if (response.status === 404) throw new ByocAwsProviderError('byoc_credential_missing');
  if (!response.ok) throw lookupFailure('response', response.status);
  let parsed: ReturnType<typeof connectionSchema.safeParse>;
  try {
    parsed = connectionSchema.safeParse(JSON.parse(await readAwsResponse(response)));
  } catch {
    throw lookupFailure('contract');
  }
  if (
    !parsed.success ||
    byocOwnerKey(parsed.data) !== byocOwnerKey(owner) ||
    (credentialId !== undefined && parsed.data.credentialId !== credentialId)
  )
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  return parsed.data;
}

export async function resolveAwsEcsByocConfiguration(
  env: Env,
  source: ByocSource
): Promise<AwsEcsByocConfiguration> {
  const connection = await fetchAwsByocConnection(env, source, source.credentialId);
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

/** The ECS adapter adds only its compute client to shared AWS access. */
export async function awsEcsRuntimeAccess(env: Env, configuration: AwsEcsByocConfiguration) {
  const { credentials, ...access } = await awsAccountAccess(env, configuration);
  return { ...access, client: createEcsClient({ credentials, region: configuration.region }) };
}
