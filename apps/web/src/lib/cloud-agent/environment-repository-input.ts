import { canonicalGitLabCloneUrl } from '@kilocode/worker-utils/git-url';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { EnvironmentRepositoryEntry } from '@kilocode/cloud-agent-profile';
import {
  buildGitLabCloneUrl,
  getGitLabInstanceUrlForOrganization,
  getGitLabInstanceUrlForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';

export const createRepositorySchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('github'), fullName: z.string().min(1).max(500) }),
  z.object({ platform: z.literal('gitlab'), projectPath: z.string().min(1).max(500) }),
  z.object({
    platform: z.literal('bitbucket'),
    fullName: z.string().min(1).max(500),
    workspaceUuid: z.uuid(),
    repositoryUuid: z.uuid(),
  }),
]);

export const environmentRepositoryListSchema = z.array(createRepositorySchema).min(1).max(100);

export async function canonicalGitLabProjectUrl(
  projectPath: string,
  userId: string,
  organizationId: string | undefined
): Promise<string> {
  const instanceUrl = organizationId
    ? await getGitLabInstanceUrlForOrganization(organizationId)
    : await getGitLabInstanceUrlForUser(userId);
  const cloneUrl = canonicalGitLabCloneUrl(buildGitLabCloneUrl(projectPath, instanceUrl));
  if (!cloneUrl) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid GitLab project path' });
  }
  return cloneUrl;
}

/**
 * The repository entry for a selected repository. The entry schema is strict, so
 * each platform sets exactly its own fields. A V1 create spreads the same entry
 * into its identity scalars. GitLab builds its clone URL from the owner's
 * instance.
 */
export async function toEnvironmentRepositoryEntry(
  repository: z.infer<typeof createRepositorySchema>,
  userId: string,
  organizationId: string | undefined
): Promise<EnvironmentRepositoryEntry> {
  switch (repository.platform) {
    case 'github':
      return { platform: 'github', repoFullName: repository.fullName };
    case 'gitlab':
      return {
        platform: 'gitlab',
        repoFullName: repository.projectPath,
        gitlabCloneUrl: await canonicalGitLabProjectUrl(
          repository.projectPath,
          userId,
          organizationId
        ),
      };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        repoFullName: repository.fullName,
        bitbucketWorkspaceUuid: repository.workspaceUuid,
        bitbucketRepositoryUuid: repository.repositoryUuid,
      };
  }
}
