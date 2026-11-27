import { createAwsEc2Client } from '@kilocode/worker-utils/aws-ec2-client';
import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';
import {
  AWS_EGRESS_PROTOCOL_VERSION,
  type AwsEc2EgressClaims,
  type AwsEc2HostLaunch,
} from '@kilocode/worker-utils/aws-egress';
import { resolveSecret } from '../auth.js';
import { mintAwsEc2EgressCredential } from '../egress/aws-credential.js';
import type { AwsEc2Workspace } from '../sandbox-control/aws-ec2-lifecycle.js';
import { generateSandboxCredential } from '../sandbox-control/credential.js';
import { ProviderCreationError } from '../sandbox-control/provider.js';
import type { Env } from '../types.js';
import { awsAccountAccess } from './aws-account-access.js';
import { validateAwsEc2Stack } from './aws-ec2-stack.js';
import { createAwsRoleSessionCache } from './aws-runtime-access.js';

const EC2_ALLOCATION_LIFETIME_MS = 24 * 60 * 60_000;

export function createAwsEc2RuntimeAccess(env: Env) {
  return createAwsRoleSessionCache(async (configuration: AwsEc2ByocConfiguration) => {
    const { credentials, ...access } = await awsAccountAccess(env, configuration);
    const ec2 = createAwsEc2Client({ credentials, region: configuration.region });
    return {
      ...access,
      ec2,
      verifyLaunch: () =>
        validateAwsEc2Stack({
          config: configuration,
          approvedImages: env.AWS_EC2_HOST_AMI_IDS,
          read: signal => access.readStack(configuration.stackId, signal),
          validateTemplate: signal => ec2.validateLaunchTemplate(configuration, signal),
        }),
    };
  });
}

export async function prepareAwsEc2Host(
  env: Env,
  sandboxId: string,
  workspace: AwsEc2Workspace,
  build?: AwsEc2EgressClaims['build']
): Promise<AwsEc2HostLaunch> {
  if (!workspace.instanceId || !workspace.volumes)
    throw new ProviderCreationError('invalid_configuration');
  const origin = env.WORKER_URL ? new URL(env.WORKER_URL) : undefined;
  if (
    !origin ||
    origin.protocol !== 'https:' ||
    origin.port ||
    origin.username ||
    origin.password ||
    origin.hash ||
    origin.search ||
    origin.pathname !== '/'
  )
    throw new ProviderCreationError('invalid_configuration');
  const signingKey = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!signingKey) throw new ProviderCreationError('invalid_configuration');
  const claims = {
    sandboxId,
    allocationId: workspace.allocation.id,
    generation: workspace.generation,
    stackId: workspace.config.stackId,
    instanceId: workspace.instanceId,
    ...(build ? { build } : {}),
  };
  const expiresAt = Math.floor((Date.now() + EC2_ALLOCATION_LIFETIME_MS) / 1000) * 1000;
  return {
    sandboxId,
    instanceId: workspace.instanceId,
    dataVolumeId: workspace.volumes.data,
    dataVolumeAction: workspace.restoreSnapshotId
      ? 'restore'
      : workspace.createdForAllocation === workspace.allocation.id
        ? 'initialize'
        : 'resume',
    allocationId: workspace.allocation.id,
    origin: origin.origin,
    expiresAt,
    token: mintAwsEc2EgressCredential(claims, signingKey, expiresAt),
    identity: {
      protocolVersion: AWS_EGRESS_PROTOCOL_VERSION,
      generation: claims.generation,
      stackId: claims.stackId,
      secret: generateSandboxCredential(),
    },
  };
}
