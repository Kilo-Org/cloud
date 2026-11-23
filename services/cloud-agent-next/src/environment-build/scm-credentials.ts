import { z } from 'zod';
import { CURRENT_CAPABILITY_PREFIX } from '@kilocode/worker-utils/scm-capability-contract';
import {
  bitbucketCloneUrl,
  type EnvironmentReferenceRepository,
} from '@kilocode/cloud-agent-profile';
import { isValidSandboxId } from '../sandbox-id.js';
import { parseControlPlaneCredential } from '../sandbox-control/managed-credential.js';
import {
  grantScmEntries,
  resolveAdditionalMembers,
  selectScmEntry,
} from '../sandbox-control/session-credential-members.js';
import {
  repositorySchema,
  scmSchema,
  refreshScmCapability,
  type AdditionalScmRepository,
} from '../sandbox-control/session-credentials.js';
import { assertAwsScmRepositories } from '../scm-broker/aws-policy.js';
import { hasManagedScmCapability, managedScmHosts } from '../scm-broker/targets.js';
import type { Env } from '../types.js';

const buildScmShape = z
  .object({
    environmentId: z.uuid(),
    buildId: z.uuid(),
    allocationId: z.uuid(),
    sandboxId: z
      .string()
      .refine(isValidSandboxId)
      .refine(id => !id.startsWith('dind-')),
    userId: z.string().min(1),
    orgId: z.string().min(1).optional(),
    provider: z.enum(['aws', 'aws-ecs']),
    containmentEnabled: z.literal(true),
    outboundContainerId: z.string().min(1),
    preparedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    repository: repositorySchema,
    scm: scmSchema,
    additionalRepositories: z
      .array(
        z
          .object({
            repository: repositorySchema.refine(repository => repository.type !== 'git'),
            scm: scmSchema,
          })
          .strict()
      )
      .optional(),
  })
  .strict();

/** The engine and immutable build allocation jointly identify broker authority. */
export function awsBuildOutboundContainerId(input: {
  provider: 'aws' | 'aws-ecs';
  environmentId: string;
  buildId: string;
  allocationId: string;
}): string {
  return `${input.provider}-environment-build:${input.environmentId}:${input.buildId}:${input.allocationId}`;
}

/** Builder authority has no model credential or Session DO member. */
export const buildScmGrantSchema = buildScmShape.superRefine((grant, ctx) => {
  if (
    grant.expiresAt <= grant.preparedAt ||
    !hasManagedScmCapability(grant) ||
    grant.outboundContainerId !== awsBuildOutboundContainerId(grant)
  ) {
    ctx.addIssue({ code: 'custom', message: 'Invalid build SCM authority' });
  }
  for (const entry of grantScmEntries(grant)) {
    const alias = entry.scm.alias ? parseControlPlaneCredential(entry.scm.alias) : null;
    if (
      entry.repository.type !== entry.scm.purpose ||
      entry.scm.nativeToken !== undefined ||
      !entry.scm.capability ||
      !entry.scm.capability.credential.startsWith(CURRENT_CAPABILITY_PREFIX[entry.scm.purpose]) ||
      entry.scm.capability.outboundContainerId !== grant.outboundContainerId ||
      alias?.sandboxId !== grant.sandboxId ||
      alias.purpose !== entry.scm.purpose ||
      (entry.repository.type === 'github' &&
        (entry.repository.authentication !== 'managed' ||
          entry.repository.accessPurpose !== 'workflow' ||
          entry.repository.allowUserAuthorization))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid build repository authority' });
  }
});
export type BuildScmGrant = z.infer<typeof buildScmGrantSchema>;

/** A builder repository always has a contained SCM capability, so it is never plain git. */
type BuildRepository = AdditionalScmRepository['repository'];

function repositoryFor(member: EnvironmentReferenceRepository): BuildRepository {
  const identity = member.identity;
  switch (identity.platform) {
    case 'github':
      return {
        type: 'github',
        repo: member.repoFullName,
        authentication: 'managed',
        accessPurpose: 'workflow',
        allowUserAuthorization: false,
      };
    case 'gitlab':
      return { type: 'gitlab', url: identity.cloneUrl };
    case 'bitbucket':
      return {
        type: 'bitbucket',
        url: bitbucketCloneUrl(member.repoFullName),
        workspaceUuid: identity.workspaceUuid,
        repositoryUuid: identity.repositoryUuid,
      };
  }
}

type ScmEnv = Partial<Pick<Env, 'GIT_TOKEN_SERVICE'>>;
type BuildOwner = Pick<
  BuildScmGrant,
  'environmentId' | 'buildId' | 'allocationId' | 'sandboxId' | 'userId' | 'orgId'
>;

/** The caller persists the complete grant before delivering any aliases to the builder. */
export async function issueBuildScmGrant(input: {
  env: ScmEnv;
  provider: 'aws' | 'aws-ecs';
  owner: BuildOwner;
  members: readonly EnvironmentReferenceRepository[];
  now: number;
  deadlineAt: number;
}): Promise<BuildScmGrant> {
  if (!input.members.length || input.members.length > 50)
    throw new Error('Invalid build repositories');
  const repositories = input.members.map(repositoryFor);
  assertAwsScmRepositories(repositories);
  const outboundContainerId = awsBuildOutboundContainerId({
    ...input.owner,
    provider: input.provider,
  });
  const issue = (repository: BuildRepository) =>
    refreshScmCapability(input.env, input.owner, repository, outboundContainerId, input.now);
  const [repository, ...additional] = repositories;
  if (!repository) throw new Error('Missing build repository');
  const scm = await issue(repository);
  const additionalRepositories = await resolveAdditionalMembers({
    members: additional.map((value, index) => ({
      repoFullName: input.members[index + 1].repoFullName,
      repository: value,
    })),
    launchScm: scm,
    existing: undefined,
    refresh: issue,
  });
  const grant = buildScmGrantSchema.parse({
    ...input.owner,
    provider: input.provider,
    containmentEnabled: true,
    outboundContainerId,
    preparedAt: input.now,
    expiresAt: input.deadlineAt,
    repository,
    scm,
    ...(additionalRepositories.length ? { additionalRepositories } : {}),
  });
  if (managedScmHosts(grant).length === 0) throw new Error('Build SCM host is unavailable');
  return grant;
}

/** Select and renew with the same repository routing and issuance rules as interactive sessions. */
export async function resolveBuildScmCredential(input: {
  env: ScmEnv;
  grant: BuildScmGrant;
  credential: string;
  url: string;
  outboundContainerId: string;
  now?: number;
}): Promise<{ grant: BuildScmGrant; credential: string } | null> {
  const now = input.now ?? Date.now();
  const parsed = buildScmGrantSchema.safeParse(input.grant);
  const alias = parseControlPlaneCredential(input.credential);
  if (
    !parsed.success ||
    alias?.sandboxId !== parsed.data.sandboxId ||
    input.outboundContainerId !== parsed.data.outboundContainerId ||
    now < parsed.data.preparedAt ||
    now >= parsed.data.expiresAt
  )
    return null;
  try {
    const url = new URL(input.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    const entry = selectScmEntry(parsed.data, input.credential, url);
    if (!entry || entry.scm.purpose !== alias.purpose || entry.repository.type === 'git')
      return null;
    const scm = await refreshScmCapability(
      input.env,
      parsed.data,
      entry.repository,
      input.outboundContainerId,
      now,
      entry.scm
    );
    const grant = buildScmGrantSchema.parse({
      ...parsed.data,
      ...(entry.additionalIndex === undefined
        ? { scm }
        : {
            additionalRepositories: parsed.data.additionalRepositories?.map((value, index) =>
              index === entry.additionalIndex ? { ...value, scm } : value
            ),
          }),
    });
    return scm.capability ? { grant, credential: scm.capability.credential } : null;
  } catch {
    return null;
  }
}
