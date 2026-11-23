import { createAwsCloudformationClient } from '@kilocode/worker-utils/aws-cloudformation';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  assumeAwsRole,
  type AwsFetch,
  awsCredentialsSchema,
  AwsRequestError,
  readAwsResponse,
} from '@kilocode/worker-utils/aws-client';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
  AWS_BYOC_TEMPLATE_VERSION,
  awsByocConfigurationSchema,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import { z } from 'zod';
import { createAwsEgressMetadataReader } from '@kilocode/worker-utils/aws-egress-store';
import { byocOwnerKey, byocOwnerSchema, type ByocOwner, type ByocSource } from './owner.js';
import type { Env } from '../types.js';
import { createMicrovmClient } from '../agent-sandbox/aws/microvm-client.js';
import { createAwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import type { AwsRuntimeAccess } from '../sandbox-control/aws-provider.js';
import { logger } from '../logger.js';

const connectionSchema = z
  .object({
    credentialId: z.uuid(),
    setupStatus: z.enum(['pending', 'building', 'ready', 'failed']),
    credentialsEncrypted: z.unknown(),
  })
  .and(byocOwnerSchema);

export class ByocAwsProviderError extends Error {
  constructor(
    readonly reason:
      | 'byoc_credential_missing'
      | 'byoc_aws_not_ready'
      | 'byoc_aws_forbidden'
      | 'byoc_aws_stack_outdated'
      | 'byoc_aws_stack_unavailable'
      | 'byoc_aws_proxy_unavailable'
      | 'byoc_aws_proxy_expired'
      | 'byoc_aws_connection_changed'
  ) {
    super(reason);
    this.name = 'ByocAwsProviderError';
  }
}

function lookupFailure(
  stage: 'configuration' | 'internal_auth' | 'request' | 'response' | 'contract',
  status?: number
) {
  logger
    .withFields({ provider: 'aws', stage, ...(status === undefined ? {} : { httpStatus: status }) })
    .warn('AWS BYOC connection lookup failed');
  return new ByocAwsProviderError('byoc_aws_not_ready');
}

export async function fetchAwsByocConnection(env: Env, owner: ByocOwner, credentialId?: string) {
  const base = env.KILOCODE_BACKEND_BASE_URL?.replace(/\/+$/, '');
  if (!base) throw lookupFailure('configuration');
  const query = new URLSearchParams({
    provider: 'aws',
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

export async function resolveAwsByocConfiguration(
  env: Env,
  source: ByocSource
): Promise<AwsByocConfiguration> {
  const connection = await fetchAwsByocConnection(env, source, source.credentialId);
  if (connection.setupStatus !== 'ready' || !env.AGENT_ENV_VARS_PRIVATE_KEY)
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  let configuration: AwsByocConfiguration;
  try {
    const decoded = decryptKeyedEnvelope(
      JSON.stringify(connection.credentialsEncrypted),
      AWS_BYOC_ENVELOPE_SCHEME,
      {
        active: { keyId: AWS_BYOC_ENVELOPE_KEY_ID, privateKeyPem: env.AGENT_ENV_VARS_PRIVATE_KEY },
      },
      `byoc-aws-configuration:v1:${byocOwnerKey(source)}:${source.credentialId}`
    );
    configuration = awsByocConfigurationSchema.parse(JSON.parse(decoded));
  } catch {
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  }
  if (configuration.templateVersion < AWS_BYOC_TEMPLATE_VERSION)
    throw new ByocAwsProviderError('byoc_aws_stack_outdated');
  return configuration;
}

/** Runtime and onboarding use the same platform role and credential configuration. */
export async function assumeAwsKiloRole(
  env: Pick<Env, 'AWS_BYOC_CREDENTIALS' | 'AWS_BYOC_KILO_ROLE_ARN'>,
  fetch?: AwsFetch,
  signal?: AbortSignal
) {
  let bootstrap;
  try {
    bootstrap = awsCredentialsSchema.parse(JSON.parse(env.AWS_BYOC_CREDENTIALS ?? ''));
  } catch {
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  }
  if (!env.AWS_BYOC_KILO_ROLE_ARN) throw new ByocAwsProviderError('byoc_aws_not_ready');
  return assumeAwsRole({
    credentials: bootstrap,
    region: 'us-east-1',
    roleArn: env.AWS_BYOC_KILO_ROLE_ARN,
    fetch,
    signal,
  });
}

export async function awsRuntimeAccess(
  env: Env,
  configuration: AwsByocConfiguration
): Promise<
  AwsRuntimeAccess & {
    expiresAt: number;
    readStack: ReturnType<typeof createAwsCloudformationClient>['describeStack'];
    readProxyMetadata: ReturnType<typeof createAwsEgressMetadataReader>;
  }
> {
  try {
    const kilo = await assumeAwsKiloRole(env);
    const credentials = await assumeAwsRole({
      credentials: kilo,
      region: configuration.region,
      roleArn: configuration.roleArn,
      externalId: configuration.externalId,
    });
    if (credentials.expiresAt === undefined) throw new ByocAwsProviderError('byoc_aws_not_ready');
    const cloudformation = createAwsCloudformationClient({
      credentials,
      region: configuration.region,
    });
    return {
      config: configuration,
      expiresAt: credentials.expiresAt,
      client: createMicrovmClient({ credentials, region: configuration.region }),
      readStack: (identity, signal) => cloudformation.describeStack(identity, signal),
      readProxyMetadata: createAwsEgressMetadataReader({
        credentials,
        region: configuration.region,
        bucket: configuration.bucket,
        stackId: configuration.stackId,
      }),
      objects: createAwsObjectStore({
        credentials,
        region: configuration.region,
        bucket: configuration.bucket,
      }),
    };
  } catch (error) {
    if (error instanceof AwsRequestError && error.status === 403)
      throw new ByocAwsProviderError('byoc_aws_forbidden');
    throw error;
  }
}
