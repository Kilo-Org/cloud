import { createAwsCloudformationClient } from '@kilocode/worker-utils/aws-cloudformation';
import {
  assumeAwsRole,
  awsCredentialsSchema,
  AwsRequestError,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';
import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';
import type { Env } from '../types.js';
import { createAwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import { ByocAwsProviderError } from './aws-errors.js';

export type AwsAccountConfiguration = Pick<
  AwsEc2ByocConfiguration,
  'region' | 'roleArn' | 'externalId' | 'bucket' | 'stackId'
>;

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

/** Runtime, egress and builds use the same two-hop role trust and scoped S3 and stack transport. */
export async function awsAccountAccess<Config extends AwsAccountConfiguration>(
  env: Env,
  configuration: Config
) {
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
      credentials,
      expiresAt: credentials.expiresAt,
      readStack: (identity: string, signal?: AbortSignal) =>
        cloudformation.describeStack(identity, signal),
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
