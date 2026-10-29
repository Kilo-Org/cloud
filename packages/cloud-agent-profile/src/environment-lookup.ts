import type { WorkerDb } from '@kilocode/db';
import {
  cloud_agent_environments,
  organizations,
  type CloudAgentEnvironment,
} from '@kilocode/db/schema';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  normalizeBitbucketUuid,
  normalizeGitlabCloneUrl,
  normalizeRepoFullName,
  type EnvironmentOwner,
  type EnvironmentPlatform,
  type EnvironmentRepositoryIdentity,
} from './environment-contracts';

/**
 * Finding environments. A V1 environment holds one repository in its identity
 * columns and a V2 environment holds several in `repositories`. One repository
 * selection matches both through the same normalized values, so a V1 row and a V2
 * row that contain the same repository are both found.
 */

export function buildEnvironmentOwnershipCondition(owner: EnvironmentOwner) {
  return owner.type === 'user'
    ? eq(cloud_agent_environments.owned_by_user_id, owner.id)
    : eq(cloud_agent_environments.owned_by_organization_id, owner.id);
}

type IdentityColumn =
  | 'repo_full_name'
  | 'gitlab_clone_url'
  | 'bitbucket_workspace_uuid'
  | 'bitbucket_repository_uuid';

/** The name of each identity column inside a V2 repository entry. */
const ENTRY_KEY_OF_COLUMN = {
  repo_full_name: 'repoFullName',
  gitlab_clone_url: 'gitlabCloneUrl',
  bitbucket_workspace_uuid: 'bitbucketWorkspaceUuid',
  bitbucket_repository_uuid: 'bitbucketRepositoryUuid',
} as const satisfies Record<IdentityColumn, string>;

/**
 * The normalized identity a repository selection is matched against: the
 * platform and the stored columns every comparison must agree on. Both match
 * forms below are built from it, so the normalization lives in exactly one place.
 */
type RepositoryMatch = {
  platform: EnvironmentPlatform;
  columns: ReadonlyArray<{ column: IdentityColumn; value: string }>;
};

function repositoryMatch(repository: EnvironmentRepositoryIdentity): RepositoryMatch {
  switch (repository.platform) {
    case 'github':
      return {
        platform: 'github',
        columns: [
          { column: 'repo_full_name', value: normalizeRepoFullName(repository.repoFullName) },
        ],
      };
    case 'gitlab':
      return {
        platform: 'gitlab',
        columns: [
          { column: 'gitlab_clone_url', value: normalizeGitlabCloneUrl(repository.cloneUrl) },
        ],
      };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        columns: [
          {
            column: 'bitbucket_workspace_uuid',
            value: normalizeBitbucketUuid(repository.workspaceUuid),
          },
          {
            column: 'bitbucket_repository_uuid',
            value: normalizeBitbucketUuid(repository.repositoryUuid),
          },
        ],
      };
  }
}

/**
 * Whether an environment contains a repository: the V1 identity columns match,
 * or `repositories` contains an entry with the same identity. Containment uses
 * the match keys only, so a renamed Bitbucket repository still matches by UUID.
 */
export function environmentContainsRepository(repository: EnvironmentRepositoryIdentity): SQL {
  const match = repositoryMatch(repository);
  const probe = {
    platform: match.platform,
    ...Object.fromEntries(
      match.columns.map(({ column, value }) => [ENTRY_KEY_OF_COLUMN[column], value])
    ),
  };
  const v1Identity = and(
    eq(cloud_agent_environments.platform, match.platform),
    ...match.columns.map(({ column, value }) => eq(cloud_agent_environments[column], value))
  );
  const v2Containment = sql`${cloud_agent_environments.repositories} @> ${JSON.stringify([probe])}::jsonb`;
  return sql`(${v1Identity} OR ${v2Containment})`;
}

/**
 * The environments that match a condition, ordered by name and id, whose owning
 * organization is active. A personal environment has no organization row, so the
 * left join keeps it.
 */
export async function selectActiveEnvironments(
  db: Pick<WorkerDb, 'select'>,
  condition: SQL | undefined
): Promise<CloudAgentEnvironment[]> {
  const rows = await db
    .select({ environment: cloud_agent_environments })
    .from(cloud_agent_environments)
    .leftJoin(
      organizations,
      eq(cloud_agent_environments.owned_by_organization_id, organizations.id)
    )
    .where(and(condition, isNull(organizations.deleted_at)))
    .orderBy(asc(cloud_agent_environments.name), asc(cloud_agent_environments.id));
  return rows.map(row => row.environment);
}

/** Every active environment of an owner that contains a repository. */
export function selectEnvironmentsContainingRepository(
  db: Pick<WorkerDb, 'select'>,
  owner: EnvironmentOwner,
  repository: EnvironmentRepositoryIdentity
): Promise<CloudAgentEnvironment[]> {
  return selectActiveEnvironments(
    db,
    and(buildEnvironmentOwnershipCondition(owner), environmentContainsRepository(repository))
  );
}

/** The outcome of choosing the environment of a session's launch repository. */
export type EnvironmentSelection =
  | { status: 'match'; environment: CloudAgentEnvironment }
  | { status: 'none' }
  /** Several environments contain the repository and none was requested. */
  | { status: 'conflict'; environments: { id: string; name: string }[] }
  /** The requested environment does not exist for this owner. */
  | { status: 'requested-not-found' }
  /** The requested environment exists for this owner but lacks the repository. */
  | { status: 'requested-without-repository' };

/**
 * Choose the environment of a session's launch repository.
 *
 * With `environmentId`, only that environment is considered: it must belong to
 * the owner and contain the repository. Without one, the owner's environments
 * that contain the repository are listed: none gives `none`, one gives `match`,
 * and several give `conflict`. It never picks an arbitrary one of several.
 */
export async function selectEnvironmentForSession(
  db: Pick<WorkerDb, 'select'>,
  input: {
    owner: EnvironmentOwner;
    repository: EnvironmentRepositoryIdentity;
    environmentId?: string;
  }
): Promise<EnvironmentSelection> {
  if (input.environmentId !== undefined) {
    const owned = and(
      eq(cloud_agent_environments.id, input.environmentId),
      buildEnvironmentOwnershipCondition(input.owner)
    );
    const [environment] = await selectActiveEnvironments(db, owned);
    if (!environment) return { status: 'requested-not-found' };
    const [containing] = await selectActiveEnvironments(
      db,
      and(owned, environmentContainsRepository(input.repository))
    );
    return containing
      ? { status: 'match', environment: containing }
      : { status: 'requested-without-repository' };
  }

  const candidates = await selectEnvironmentsContainingRepository(
    db,
    input.owner,
    input.repository
  );
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length > 1) {
    return {
      status: 'conflict',
      environments: candidates.map(({ id, name }) => ({ id, name })),
    };
  }
  return { status: 'match', environment: candidates[0] };
}
