import { z } from 'zod';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import { awsEc2FilesystemBase } from '../byoc/aws-ec2-provider.js';
import {
  fetchAwsByocConnection,
  resolveAwsEc2ByocConfiguration,
} from '../byoc/aws-credential-resolver.js';
import { ByocAwsProviderError } from '../byoc/aws-errors.js';
import { enrolledByocOwner, type ByocOwner } from '../byoc/owner.js';
import type { Env } from '../types.js';
import { BuilderTargetMismatchError } from './builder-errors.js';

export const awsEc2BuildTargetSchema = z
  .object({
    provider: z.literal('aws-ec2'),
    instance: z.literal('aws-ec2-8g'),
    credentialId: z.uuid(),
    baseImage: z.string().max(256),
  })
  .strict()
  .refine(target => {
    const prefix = `aws-ec2-ebs:v1:${target.credentialId}/`;
    return (
      target.baseImage.startsWith(prefix) &&
      z.uuid().safeParse(target.baseImage.slice(prefix.length)).success
    );
  });

export type AwsEc2BuilderAllocation = {
  sandboxId: `ses-${string}`;
  allocationId: string;
  environmentId: string;
  buildId: string;
  actorUserId: string;
  owner: EnvironmentReference['owner'];
  provider: 'aws-ec2';
  target: z.infer<typeof awsEc2BuildTargetSchema>;
};
export function awsBuildOwner(owner: EnvironmentReference['owner']): ByocOwner {
  return owner.type === 'organization' ? { organizationId: owner.id } : { userId: owner.id };
}

export async function resolveAwsEc2EnvironmentBuildTarget(
  env: Env,
  reference: EnvironmentReference
) {
  const provider = 'aws-ec2' as const;
  const owner = enrolledByocOwner(
    env.BYOC_AWS_IDS,
    reference.owner.type === 'organization'
      ? { orgId: reference.owner.id }
      : { userId: reference.owner.id }
  );
  const unavailable = { ok: false as const, provider, reason: 'AWS compute setup is not ready' };
  if (!owner) return unavailable;
  try {
    const connection = await fetchAwsByocConnection(env, owner);
    if (connection.setupStatus !== 'ready') return unavailable;
    const configuration = await resolveAwsEc2ByocConfiguration(env, {
      ...owner,
      credentialId: connection.credentialId,
    });
    return {
      ok: true as const,
      target: awsEc2BuildTargetSchema.parse({
        provider,
        instance: 'aws-ec2-8g',
        credentialId: connection.credentialId,
        baseImage: awsEc2FilesystemBase(connection.credentialId, configuration),
      }),
    };
  } catch (error) {
    if (error instanceof ByocAwsProviderError && error.reason === 'byoc_credential_missing')
      return unavailable;
    throw error;
  }
}

export async function resolveAwsEc2BuildConfiguration(
  env: Env,
  allocation: AwsEc2BuilderAllocation
) {
  const source = {
    ...awsBuildOwner(allocation.owner),
    credentialId: allocation.target.credentialId,
  };
  const configuration = await resolveAwsEc2ByocConfiguration(env, source);
  if (awsEc2FilesystemBase(source.credentialId, configuration) !== allocation.target.baseImage)
    throw new BuilderTargetMismatchError();
  return configuration;
}
