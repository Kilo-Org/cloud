import { TRPCError } from '@trpc/server';
import type { CloudAgentEnvironment } from '@kilocode/db/schema';
import {
  repositoryLeaf,
  resolveEnvironmentIdentity,
  type EnvironmentCreateInput,
  type EnvironmentOwner,
  type EnvironmentReference,
  type EnvironmentReferenceRepository,
  type EnvironmentRepositoryIdentity,
  type EnvironmentIdentityResponse,
} from './environment-contracts';
import {
  environmentRepositoriesSchema,
  type EnvironmentRepositoryEntry,
} from './environment-repository-entry';

/**
 * Where an environment keeps its repositories. A V1 row has one repository in
 * the identity columns and a null `repositories`; a V2 row has one or more in
 * `repositories` and null identity columns. The database check allows exactly
 * these two shapes. This module is the only code that reads or writes the V2
 * column: every write and every read goes through `environmentRepositoriesSchema`.
 */

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

function corruptIdentity(): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Environment repository identity is incomplete',
  });
}

/**
 * Validate a submitted repository list. The error message names the offending
 * repositories, because the issue messages of the schema do.
 */
export function parseSubmittedRepositories(value: unknown): EnvironmentRepositoryEntry[] {
  const parsed = environmentRepositoriesSchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map(issue => issue.message).join('; '));
  }
  return parsed.data;
}

/** The repositories of a V2 row, or null for a V1 row. */
export function readRepositories(
  environment: Pick<CloudAgentEnvironment, 'repositories'>
): EnvironmentRepositoryEntry[] | null {
  if (environment.repositories === null) return null;
  const parsed = environmentRepositoriesSchema.safeParse(environment.repositories);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Environment repositories are invalid',
    });
  }
  return parsed.data;
}

/** The columns a create writes for the repositories: V1 identity, or V2 list. */
export function repositoryColumnsOfCreate(input: EnvironmentCreateInput) {
  const hasIdentity = [
    input.platform,
    input.repoFullName,
    input.gitlabCloneUrl,
    input.bitbucketWorkspaceUuid,
    input.bitbucketRepositoryUuid,
  ].some(value => value !== undefined);

  if (input.repositories !== undefined) {
    if (hasIdentity) {
      throw badRequest('Provide either one repository identity or repositories, not both');
    }
    return { repositories: parseSubmittedRepositories(input.repositories) };
  }
  if (input.platform === undefined || input.repoFullName === undefined) {
    throw badRequest('Provide either one repository identity or repositories');
  }
  return { platform: input.platform, ...resolveEnvironmentIdentity(input) };
}

/**
 * The repositories an update stores, and whether they differ from the stored
 * ones. Only a V2 environment can change its repositories; a V1 environment has
 * no conversion. Order is part of the value.
 */
export function planRepositoriesUpdate(
  environment: CloudAgentEnvironment,
  submitted: unknown
): { repositories: EnvironmentRepositoryEntry[]; changed: boolean } {
  const stored = readRepositories(environment);
  if (stored === null) {
    throw badRequest('Repositories can only be changed on a multi-repository environment');
  }
  const repositories = parseSubmittedRepositories(submitted);
  return { repositories, changed: JSON.stringify(repositories) !== JSON.stringify(stored) };
}

/** The stored identity of a V1 row, in the shape every comparison uses. */
export function repositoryIdentityOf(
  environment: CloudAgentEnvironment
): EnvironmentRepositoryIdentity {
  switch (environment.platform) {
    case 'github':
      if (environment.repo_full_name === null) break;
      return { platform: 'github', repoFullName: environment.repo_full_name };
    case 'gitlab':
      if (environment.gitlab_clone_url === null) break;
      return { platform: 'gitlab', cloneUrl: environment.gitlab_clone_url };
    case 'bitbucket':
      if (
        environment.bitbucket_workspace_uuid === null ||
        environment.bitbucket_repository_uuid === null
      ) {
        break;
      }
      return {
        platform: 'bitbucket',
        workspaceUuid: environment.bitbucket_workspace_uuid,
        repositoryUuid: environment.bitbucket_repository_uuid,
      };
  }
  throw corruptIdentity();
}

/** The canonical path of a V1 row, which its clone URL is built from. */
export function repositoryPathOf(environment: CloudAgentEnvironment): string {
  if (environment.repo_full_name === null) throw corruptIdentity();
  return environment.repo_full_name;
}

function identityOfEntry(entry: EnvironmentRepositoryEntry): EnvironmentRepositoryIdentity {
  switch (entry.platform) {
    case 'github':
      return { platform: 'github', repoFullName: entry.repoFullName };
    case 'gitlab':
      return { platform: 'gitlab', cloneUrl: entry.gitlabCloneUrl };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        workspaceUuid: entry.bitbucketWorkspaceUuid,
        repositoryUuid: entry.bitbucketRepositoryUuid,
      };
  }
}

/** The session view of one V2 repository. */
export function referenceRepositoryOf(
  entry: EnvironmentRepositoryEntry
): EnvironmentReferenceRepository {
  return {
    identity: identityOfEntry(entry),
    repoFullName: entry.repoFullName,
    leaf: repositoryLeaf(entry.repoFullName),
  };
}

/** The V1 or V2 repositories of a row, as a session reference. */
export function referenceOf(
  environment: CloudAgentEnvironment,
  owner: EnvironmentOwner
): EnvironmentReference {
  const base = {
    environmentId: environment.id,
    owner,
    configurationRevision: environment.configuration_revision,
  };
  const repositories = readRepositories(environment);
  return repositories === null
    ? { ...base, repository: repositoryIdentityOf(environment) }
    : { ...base, repositories: repositories.map(referenceRepositoryOf) };
}

/** The repository part of a response: V1 identity scalars, or the V2 list. */
export function identityResponseOf(
  environment: CloudAgentEnvironment
): EnvironmentIdentityResponse {
  const repositories = readRepositories(environment);
  if (repositories !== null) return { repositories };
  if (environment.platform === null || environment.repo_full_name === null) {
    throw corruptIdentity();
  }
  return {
    platform: environment.platform,
    repoFullName: environment.repo_full_name,
    gitlabCloneUrl: environment.gitlab_clone_url,
    bitbucketWorkspaceUuid: environment.bitbucket_workspace_uuid,
    bitbucketRepositoryUuid: environment.bitbucket_repository_uuid,
  };
}
