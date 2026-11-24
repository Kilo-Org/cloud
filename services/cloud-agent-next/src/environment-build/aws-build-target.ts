import { builderSandboxIdForBuild } from './builder-identity.js';
import { z } from 'zod';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import { providerSupports } from '@kilocode/worker-utils/sandbox-provider-capabilities';
import { enrolledByocOwner, type ByocOwner } from '../byoc/owner.js';
import {
  fetchAwsByocConnection,
  resolveAwsEcsByocConfiguration,
} from '../byoc/aws-credential-resolver.js';
import { ByocAwsProviderError } from '../byoc/aws-errors.js';
import { awsEcsArchiveBaseImage, decodeAwsArchiveBase } from '../shared/aws-archive.js';
import type { Env } from '../types.js';
import { BuilderTargetMismatchError } from './builder-errors.js';

export const awsBuildTargetSchema = z
  .object({
    provider: z.literal('aws-ecs'),
    instance: z.literal('aws-ecs-8g'),
    credentialId: z.uuid(),
    baseImage: z.string().min(1).max(8192),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (decodeAwsArchiveBase(target.baseImage)?.connectionId !== target.credentialId)
      ctx.addIssue({
        code: 'custom',
        path: ['baseImage'],
        message: 'AWS build base must match its connection',
      });
  });
export type AwsBuildTarget = z.infer<typeof awsBuildTargetSchema>;

export type AwsBuilderAllocation = {
  provider: 'aws-ecs';
  sandboxId: `ses-${string}`;
  allocationId: string;
  environmentId: string;
  buildId: string;
  actorUserId: string;
  owner: EnvironmentReference['owner'];
  target: AwsBuildTarget;
};
export function awsBuilderAllocation(
  input: Omit<AwsBuilderAllocation, 'provider' | 'sandboxId'>
): AwsBuilderAllocation {
  return {
    ...input,
    provider: 'aws-ecs',
    sandboxId: builderSandboxIdForBuild(input.buildId),
  };
}

export function awsBuildOwner(owner: EnvironmentReference['owner']): ByocOwner {
  return owner.type === 'organization' ? { organizationId: owner.id } : { userId: owner.id };
}

/** A queued build pins the owner connection and exact filesystem base before allocation. */
export async function resolveAwsEnvironmentBuildTarget(env: Env, reference: EnvironmentReference) {
  const provider = 'aws-ecs' as const;
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
    const connection = await fetchAwsByocConnection(env, owner);
    if (connection.setupStatus !== 'ready')
      return { ok: false as const, provider, reason: 'AWS compute setup is not ready' };
    const configuration = await resolveAwsEcsByocConfiguration(env, {
      ...owner,
      credentialId: connection.credentialId,
    });
    return {
      ok: true as const,
      target: awsBuildTargetSchema.parse({
        provider,
        instance: 'aws-ecs-8g',
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
  const configuration = await resolveAwsEcsByocConfiguration(env, source);
  if (awsEcsArchiveBaseImage(source.credentialId, configuration) !== allocation.target.baseImage)
    throw new BuilderTargetMismatchError();
  return configuration;
}
