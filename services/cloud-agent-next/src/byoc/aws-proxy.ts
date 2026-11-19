import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { AwsEgressMetadataError } from '@kilocode/worker-utils/aws-egress-store';
import {
  AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import { AWS_EGRESS_PROTOCOL_VERSION } from '@kilocode/worker-utils/aws-egress';
import type {
  AwsEgressPublicDeployment,
  AwsEgressSharedIdentity,
} from '@kilocode/worker-utils/aws-egress';
import type { ProviderStartup } from '../sandbox-control/provider.js';
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { AwsEcsProviderRef } from '../sandbox-control/aws-ecs-operation.js';
import type { AwsProviderRef } from '../sandbox-control/aws-operation.js';
import {
  verifyAwsEgressCredential,
  mintAwsEgressCredentialUntil,
} from '../egress/aws-credential.js';
import { ByocAwsProviderError } from './aws-credential-resolver.js';

export type AwsProxyMetadata = {
  deployment: AwsEgressPublicDeployment;
  identity: AwsEgressSharedIdentity;
};

/** Safe metadata reads retry transient AWS failures only. A missing or changed deployment needs setup repair. */
export async function readPinnedAwsProxyDeployment(
  config: Pick<AwsByocConfiguration, 'proxy' | 'proxyProtocolVersion' | 'stackId'>,
  read: (signal?: AbortSignal) => Promise<AwsProxyMetadata>
): Promise<AwsProxyMetadata> {
  if (!config.proxy || config.proxyProtocolVersion !== AWS_EGRESS_PROTOCOL_VERSION)
    throw new ByocAwsProviderError('byoc_aws_stack_outdated');
  let metadata: AwsProxyMetadata | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      metadata = await read(AbortSignal.timeout(5_000));
      break;
    } catch (error) {
      if (error instanceof AwsRequestError && error.status === 403)
        throw new ByocAwsProviderError('byoc_aws_forbidden');
      if (error instanceof AwsEgressMetadataError && error.code === 'expired')
        throw new ByocAwsProviderError('byoc_aws_proxy_expired');
      if (error instanceof AwsEgressMetadataError && error.code !== 'unavailable')
        throw new ByocAwsProviderError('byoc_aws_connection_changed');
      const transient =
        error instanceof AwsRequestError &&
        (error.status === 0 || error.status === 429 || error.status >= 500);
      if (!transient || attempt === 2) throw new ByocAwsProviderError('byoc_aws_proxy_unavailable');
      await new Promise(resolve => setTimeout(resolve, [100, 250][attempt]));
    }
  }
  if (!metadata) throw new ByocAwsProviderError('byoc_aws_proxy_unavailable');
  if (
    metadata.deployment.generation !== config.proxy.generation ||
    metadata.deployment.caFingerprint !== config.proxy.caFingerprint ||
    metadata.deployment.hostname !== config.proxy.hostname ||
    metadata.deployment.stackId !== config.stackId ||
    metadata.identity.generation !== config.proxy.generation ||
    metadata.identity.stackId !== config.stackId
  )
    throw new ByocAwsProviderError('byoc_aws_connection_changed');
  return metadata;
}

type ProxyStartupInput = {
  startup: ProviderStartup;
  ref: { sandboxId: string; intentId: string };
  configuration: Pick<AwsByocConfiguration, 'proxy' | 'proxyProtocolVersion' | 'stackId'>;
  readMetadata: (signal?: AbortSignal) => Promise<AwsProxyMetadata>;
  signingSecret: string;
  now?: number;
};

export function prepareAwsProxyStartup(
  input: ProxyStartupInput & { ref: AwsProviderRef; configuration: AwsByocConfiguration }
): Promise<ProviderStartup> {
  return prepareProxyStartup(input, () => Date.now() + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000);
}

/** ECS credentials end at the verified deployment certificate expiry, rather than eight hours after launch. */
export function prepareAwsEcsProxyStartup(
  input: ProxyStartupInput & { ref: AwsEcsProviderRef; configuration: AwsEcsByocConfiguration }
): Promise<ProviderStartup> {
  return prepareProxyStartup(input, deployment => Date.parse(deployment.expiresAt));
}

async function prepareProxyStartup(
  input: ProxyStartupInput,
  expiresAt: (deployment: AwsEgressPublicDeployment) => number
): Promise<ProviderStartup> {
  const { deployment } = await readPinnedAwsProxyDeployment(
    input.configuration,
    input.readMetadata
  );
  // The reserve checks certificate health. It does not impose an ECS compute deadline.
  if (
    !Number.isFinite(Date.parse(deployment.expiresAt)) ||
    Date.parse(deployment.expiresAt) <=
      (input.now ?? Date.now()) + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000
  )
    throw new ByocAwsProviderError('byoc_aws_proxy_expired');
  const token = mintAwsEgressCredentialUntil(
    {
      launchCredential: input.startup.env.SANDBOX_CONTROL_CREDENTIAL ?? '',
      generation: deployment.generation,
      stackId: deployment.stackId,
    },
    input.signingSecret,
    expiresAt(deployment)
  );
  const claims = verifyAwsEgressCredential(token, input.signingSecret);
  if (claims?.sandboxId !== input.ref.sandboxId || claims.allocationId !== input.ref.intentId)
    throw new ByocAwsProviderError('byoc_aws_connection_changed');
  return awsProxyStartup(input.startup, deployment, token);
}

/** Shared transport environment; callers supply their purpose-specific authenticated credential. */
export function awsProxyStartup(
  startup: ProviderStartup,
  deployment: AwsEgressPublicDeployment,
  token: string
): ProviderStartup {
  const proxy = new URL(`http://${deployment.hostname}:${deployment.port}`);
  proxy.username = 'kilo';
  proxy.password = token;
  return {
    ...startup,
    env: {
      ...startup.env,
      HTTPS_PROXY: proxy.href,
      HTTP_PROXY: proxy.href,
      ALL_PROXY: proxy.href,
      https_proxy: proxy.href,
      http_proxy: proxy.href,
      all_proxy: proxy.href,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      NODE_USE_ENV_PROXY: '1',
      KILO_AWS_EGRESS_CA_CERTIFICATE: deployment.caCertificate,
    },
  };
}
