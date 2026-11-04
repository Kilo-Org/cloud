import type { WorkerDb } from '@kilocode/db/client';
import { organization_memberships } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  resolveCloudAgentGitHubAuthForRepo,
  resolveManagedBitbucketToken,
  resolveManagedGitLabToken,
} from '../services/git-token-service-client.js';
import type { Env } from '../types.js';
import type { EnvironmentBuildGit } from '../shared/environment-build-protocol.js';
import {
  bitbucketCloneUrl,
  type EnvironmentReferenceRepository,
} from '@kilocode/cloud-agent-profile';
import type { EnvironmentScope } from './reference.js';

/**
 * Who may do what with an environment's builds (plan "Build admission and
 * execution"). PostgreSQL is authoritative; the coordinator rechecks these
 * before allocation and again before publication.
 */

/** Organization roles with environment-management authority (`@kilocode/app-shared`). */
const ENVIRONMENT_MANAGE_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export type EnvironmentActorAccess = 'manage' | 'read' | 'none';

/**
 * A personal environment is managed only by its owner. An organization
 * environment is managed by owners and admins and readable by every member.
 */
export async function environmentActorAccess(
  db: WorkerDb,
  owner: EnvironmentScope['owner'],
  userId: string
): Promise<EnvironmentActorAccess> {
  if (owner.type === 'user') return owner.id === userId ? 'manage' : 'none';
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, owner.id),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);
  if (!membership) return 'none';
  return ENVIRONMENT_MANAGE_ROLES.has(membership.role) ? 'manage' : 'read';
}

export type BuilderGitSource =
  | { ok: true; git: EnvironmentBuildGit }
  | { ok: false; reason: 'repository_unauthorized' | 'unavailable' };

const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  'service_not_configured',
  'rpc_error',
  'temporarily_unavailable',
]);

/**
 * A short-lived, repository-scoped Git source for the initiating actor. A
 * resolved token is also the repository authorization check: the integration
 * must still grant the actor's owner access to this repository.
 *
 * One call resolves one member. A multi-member build calls this once per member.
 */
export async function resolveBuilderGitSource(
  env: Pick<
    Env,
    | 'GIT_TOKEN_SERVICE'
    | 'GITHUB_APP_SLUG'
    | 'GITHUB_LITE_APP_SLUG'
    | 'GITHUB_APP_BOT_USER_ID'
    | 'GITHUB_LITE_APP_BOT_USER_ID'
  >,
  input: {
    reference: EnvironmentScope;
    member: EnvironmentReferenceRepository;
    actorUserId: string;
  }
): Promise<BuilderGitSource> {
  const { reference, actorUserId, member } = input;
  const repository = member.identity;
  const repoFullName = member.repoFullName;
  const orgId = reference.owner.type === 'organization' ? reference.owner.id : undefined;
  switch (repository.platform) {
    case 'github': {
      const resolved = await resolveCloudAgentGitHubAuthForRepo(env, {
        githubRepo: repoFullName,
        userId: actorUserId,
        ...(orgId ? { orgId } : {}),
        accessPurpose: 'workflow',
        allowUserAuthorization: false,
      });
      if (!resolved.success) {
        return {
          ok: false,
          reason: TRANSIENT_REASONS.has(resolved.error.reason)
            ? 'unavailable'
            : 'repository_unauthorized',
        };
      }
      return {
        ok: true,
        git: {
          url: `https://github.com/${repoFullName}.git`,
          token: resolved.value.githubToken,
          platform: 'github',
        },
      };
    }
    case 'gitlab': {
      const resolved = await resolveManagedGitLabToken(env, {
        userId: actorUserId,
        ...(orgId ? { orgId } : {}),
        repositoryUrl: repository.cloneUrl,
      });
      if (!resolved.success) {
        return {
          ok: false,
          reason: TRANSIENT_REASONS.has(resolved.reason)
            ? 'unavailable'
            : 'repository_unauthorized',
        };
      }
      return {
        ok: true,
        git: { url: repository.cloneUrl, token: resolved.token, platform: 'gitlab' },
      };
    }
    case 'bitbucket': {
      if (!orgId) return { ok: false, reason: 'repository_unauthorized' };
      const url = bitbucketCloneUrl(repoFullName);
      const resolved = await resolveManagedBitbucketToken(env, {
        userId: actorUserId,
        orgId,
        workspaceUuid: repository.workspaceUuid,
        repositoryUuid: repository.repositoryUuid,
        repositoryUrl: url,
      });
      if (!resolved.success) {
        return {
          ok: false,
          reason: TRANSIENT_REASONS.has(resolved.reason)
            ? 'unavailable'
            : 'repository_unauthorized',
        };
      }
      return { ok: true, git: { url, token: resolved.token, platform: 'bitbucket' } };
    }
  }
}
