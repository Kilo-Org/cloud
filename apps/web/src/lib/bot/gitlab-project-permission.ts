import 'server-only';
import {
  getGitLabInstanceUrlForUser,
  getGitLabTokenForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import {
  fetchGitLabProjectAccessLevel,
  GITLAB_ACCESS_LEVELS,
} from '@/lib/integrations/platforms/gitlab/adapter';
import {
  DEFAULT_GITLAB_INSTANCE_URL,
  normalizeGitLabInstanceUrl,
} from '@/lib/integrations/platforms/gitlab/instance-url';

export type GitLabProjectAuthorization = { allowed: true } | { allowed: false; markdown: string };

function projectAccessRequiredMarkdown(project: string): string {
  return (
    `I couldn't confirm that your GitLab connection has access to \`${project}\`, so I didn't ` +
    'start any work. Connect or refresh a GitLab connection in Kilo Code settings that can reach ' +
    'the project, then mention me again.'
  );
}

/**
 * The project and the requester's connection could not be placed on one GitLab
 * instance, so the connection's credential cannot be used for the project.
 */
function instanceMismatchMarkdown(project: string): string {
  return (
    `I couldn't start work on \`${project}\` because it isn't on the GitLab instance your ` +
    'connection uses. Connect or refresh the matching GitLab connection in Kilo Code settings, ' +
    'then mention me again.'
  );
}

function projectWriteAccessRequiredMarkdown(project: string): string {
  return (
    `I couldn't confirm that your GitLab account has write access to \`${project}\`, so I didn't ` +
    'start any work. Ask a project maintainer for Developer access on the project, then mention ' +
    'me again.'
  );
}

/** The case-insensitive exact full-path compare used by every GitLab scope check. */
function isSameProject(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Requires a GitLab identity that reaches the requested project with write
 * access.
 *
 * A GitLab integration belongs to an organization or a user, and its
 * connection reaches the projects of one instance. A caller without a
 * requesting account may only use `threadRepository`, the project the
 * conversation belongs to. A caller with a requesting account may use a
 * project on the session's instance that account's own GitLab connection
 * reaches with write access.
 *
 * A lookup that fails is not answered here: it propagates to the caller, which
 * reports it as one transient reply.
 */
export async function authorizeGitLabProject(params: {
  /** Requested project path, `group/project` or `group/subgroup/project`. */
  project: string;
  /** Instance URL of the connection whose credential the session will use. */
  projectInstanceUrl: string;
  /** The person who triggered this run, when the platform supplied a verified account. */
  requesterUserId?: string;
  /** Repository of the conversation the bot was mentioned in. */
  threadRepository?: string | null;
}): Promise<GitLabProjectAuthorization> {
  const { project, projectInstanceUrl, requesterUserId, threadRepository } = params;

  if (!requesterUserId) {
    if (threadRepository && isSameProject(project, threadRepository)) {
      return { allowed: true };
    }
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }

  const requesterInstanceUrl = await getGitLabInstanceUrlForUser(requesterUserId);
  // Comparing the normalized URLs, base path included, keeps two self-managed
  // instances apart that share a host. An unreadable value leaves the
  // comparison unanswered, never allowed.
  try {
    const projectInstance = normalizeGitLabInstanceUrl(projectInstanceUrl);
    const requesterInstance = normalizeGitLabInstanceUrl(
      requesterInstanceUrl || DEFAULT_GITLAB_INSTANCE_URL
    );
    if (requesterInstance !== projectInstance) {
      return { allowed: false, markdown: instanceMismatchMarkdown(project) };
    }
  } catch {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }

  // Write access is read with the requester's own credential, so the answer
  // covers the project the session will use on this instance.
  const requesterToken = await getGitLabTokenForUser(requesterUserId);
  if (!requesterToken) {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }
  const accessLevel = await fetchGitLabProjectAccessLevel(
    requesterToken,
    project,
    requesterInstanceUrl || DEFAULT_GITLAB_INSTANCE_URL
  );
  if (accessLevel === null || accessLevel < GITLAB_ACCESS_LEVELS.DEVELOPER) {
    return { allowed: false, markdown: projectWriteAccessRequiredMarkdown(project) };
  }

  return { allowed: true };
}
