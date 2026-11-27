import { ByocAwsProviderError } from './aws-errors.js';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { readAwsResponse } from '@kilocode/worker-utils/aws-client';
import {
  awsEc2ByocConfigurationSchema,
  type AwsEc2ByocConfiguration,
} from '@kilocode/worker-utils/aws-ec2';
import { awsEc2ConfigurationEnvelope } from '@kilocode/worker-utils/aws-onboarding';
import { AWS_BYOC_ENVELOPE_KEY_ID } from '@kilocode/worker-utils/aws-byoc';
import { z } from 'zod';
import { byocOwnerKey, byocOwnerSchema, type ByocOwner, type ByocSource } from './owner.js';
import type { Env } from '../types.js';
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

function lookupFailure(
  stage: 'configuration' | 'internal_auth' | 'request' | 'response' | 'contract',
  status?: number
) {
  logger
    .withFields({
      provider: 'aws-ec2',
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
    provider: 'aws-ec2',
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

export async function resolveAwsEc2ByocConfiguration(
  env: Env,
  source: ByocSource
): Promise<AwsEc2ByocConfiguration> {
  const connection = await fetchAwsByocConnection(env, source, source.credentialId);
  if (connection.setupStatus !== 'ready' || !env.AGENT_ENV_VARS_PRIVATE_KEY)
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  try {
    const purpose = awsEc2ConfigurationEnvelope(
      source.organizationId !== undefined
        ? { organizationId: source.organizationId }
        : { userId: source.userId },
      source.credentialId
    );
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(connection.credentialsEncrypted),
      purpose.scheme,
      {
        active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: env.AGENT_ENV_VARS_PRIVATE_KEY },
      },
      purpose.aad
    );
    return awsEc2ByocConfigurationSchema.parse(JSON.parse(decoded));
  } catch {
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  }
}
