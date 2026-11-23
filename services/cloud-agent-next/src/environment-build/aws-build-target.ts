import { builderSandboxIdForBuild } from './builder-identity.js';
import { z } from 'zod';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import {
  getSandboxAllocationProvider,
  type SandboxAllocation,
} from '@kilocode/worker-utils/sandbox-allocation';
import { providerSupports } from '@kilocode/worker-utils/sandbox-provider-capabilities';
import { enrolledByocOwner, type ByocOwner } from '../byoc/owner.js';
import {
  fetchAwsProviderConnection,
  resolveAwsByocConfiguration,
} from '../byoc/aws-credential-resolver.js';
import { resolveAwsEcsByocConfiguration } from '../byoc/aws-ecs-credential-resolver.js';
import { ByocAwsProviderError } from '../byoc/aws-errors.js';
import {
  awsArchiveBaseImage,
  awsEcsArchiveBaseImage,
  decodeAwsArchiveBase,
} from '../shared/aws-archive.js';
import type { Env } from '../types.js';
import { BuilderTargetMismatchError } from './builder-errors.js';

const common = { credentialId: z.uuid(), baseImage: z.string().min(1).max(8192) };
function validBase(
  target: { provider: 'aws' | 'aws-ecs'; credentialId: string; baseImage: string },
  ctx: z.RefinementCtx
) {
  const base = decodeAwsArchiveBase(target.baseImage);
  const prefix = target.provider === 'aws' ? 'aws-image:v1:' : 'aws-ecs-image:v1:';
  if (!base || base.connectionId !== target.credentialId || !target.baseImage.startsWith(prefix))
    ctx.addIssue({
      code: 'custom',
      path: ['baseImage'],
      message: 'AWS build base must match its engine and connection',
    });
}
export const awsBuildTargetOptions = [
  z
    .object({ provider: z.literal('aws'), instance: z.literal('aws-microvm-8g'), ...common })
    .strict()
    .superRefine(validBase),
  z
    .object({ provider: z.literal('aws-ecs'), instance: z.literal('aws-ecs-8g'), ...common })
    .strict()
    .superRefine(validBase),
] as const;
export const awsBuildTargetSchema = z.discriminatedUnion('provider', awsBuildTargetOptions);
export type AwsBuildTarget = z.infer<typeof awsBuildTargetSchema>;

export type AwsBuilderAllocation = {
  sandboxId: `ses-${string}`;
  allocationId: string;
  environmentId: string;
  buildId: string;
  actorUserId: string;
  owner: EnvironmentReference['owner'];
} & (
  | { provider: 'aws'; target: Extract<AwsBuildTarget, { provider: 'aws' }> }
  | { provider: 'aws-ecs'; target: Extract<AwsBuildTarget, { provider: 'aws-ecs' }> }
);
export function awsBuilderAllocation(
  input: Omit<AwsBuilderAllocation, 'provider' | 'target' | 'sandboxId'> & {
    target: AwsBuildTarget;
  }
): AwsBuilderAllocation {
  const { target, ...identity } = input;
  const common = { ...identity, sandboxId: builderSandboxIdForBuild(input.buildId) };
  return target.provider === 'aws'
    ? { ...common, provider: 'aws', target }
    : { ...common, provider: 'aws-ecs', target };
}

export function awsBuildOwner(owner: EnvironmentReference['owner']): ByocOwner {
  return owner.type === 'organization' ? { organizationId: owner.id } : { userId: owner.id };
}

/** A queued build pins the owner connection and exact filesystem base before allocation. */
export async function resolveAwsEnvironmentBuildTarget(
  env: Env,
  reference: EnvironmentReference,
  allocation: SandboxAllocation
) {
  const provider = getSandboxAllocationProvider(allocation);
  if (provider !== 'aws' && provider !== 'aws-ecs') throw new BuilderTargetMismatchError();
  if (!providerSupports(provider, 'environmentSnapshots'))
    return {
      ok: false as const,
      provider,
      reason: 'Environment snapshots are not supported by this provider',
    };
  const owner = enrolledByocOwner(
    env.BYOC_AWS_IDS,
    reference.owner.type === 'organization'
      ? { orgId: reference.owner.id }
      : { userId: reference.owner.id }
  );
  if (!owner)
    return { ok: false as const, provider, reason: 'AWS BYOC is not enabled for this owner' };
  try {
    const connection = await fetchAwsProviderConnection(env, owner, provider);
    if (connection.setupStatus !== 'ready')
      return { ok: false as const, provider, reason: 'AWS compute setup is not ready' };
    const source = { ...owner, credentialId: connection.credentialId };
    if (provider === 'aws') {
      if (allocation !== 'aws-microvm-8g')
        return {
          ok: false as const,
          provider,
          reason: 'The saved AWS allocation is not supported',
        };
      const configuration = await resolveAwsByocConfiguration(env, source);
      if (!configuration.proxy)
        return {
          ok: false as const,
          provider,
          reason: 'AWS compute requires a verified egress proxy',
        };
      return {
        ok: true as const,
        target: awsBuildTargetSchema.parse({
          provider,
          instance: allocation,
          credentialId: connection.credentialId,
          baseImage: awsArchiveBaseImage(connection.credentialId, configuration),
        }),
      };
    }
    if (allocation !== 'aws-ecs-8g')
      return { ok: false as const, provider, reason: 'The saved AWS allocation is not supported' };
    const configuration = await resolveAwsEcsByocConfiguration(env, source);
    return {
      ok: true as const,
      target: awsBuildTargetSchema.parse({
        provider,
        instance: allocation,
        credentialId: connection.credentialId,
        baseImage: awsEcsArchiveBaseImage(connection.credentialId, configuration),
      }),
    };
  } catch (error) {
    if (error instanceof ByocAwsProviderError && error.reason === 'byoc_credential_missing')
      return { ok: false as const, provider, reason: 'AWS credentials are unavailable' };
    throw error;
  }
}

/** A running build never changes its pinned connection or image. */
export async function resolveAwsBuildConfiguration(env: Env, allocation: AwsBuilderAllocation) {
  const source = {
    ...awsBuildOwner(allocation.owner),
    credentialId: allocation.target.credentialId,
  };
  if (allocation.provider === 'aws') {
    const configuration = await resolveAwsByocConfiguration(env, source);
    if (
      !configuration.proxy ||
      awsArchiveBaseImage(source.credentialId, configuration) !== allocation.target.baseImage
    )
      throw new BuilderTargetMismatchError();
    return { provider: 'aws' as const, configuration };
  }
  const configuration = await resolveAwsEcsByocConfiguration(env, source);
  if (awsEcsArchiveBaseImage(source.credentialId, configuration) !== allocation.target.baseImage)
    throw new BuilderTargetMismatchError();
  return { provider: 'aws-ecs' as const, configuration };
}
