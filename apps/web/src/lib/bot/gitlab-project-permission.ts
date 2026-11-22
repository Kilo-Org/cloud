import 'server-only';
import { gitlabInstanceOrigin } from '@kilocode/app-shared/provider-review';
import { fetchGitLabRepositoriesForUser } from '@/lib/cloud-agent/gitlab-integration-helpers';
import { normalizeGitLabInstanceUrl } from '@/lib/integrations/platforms/gitlab/instance-url';

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

/**
 * The comparable origin of an instance URL, or null when the value cannot be
 * read as one: a value that does not parse leaves the comparison unanswered.
 */
function instanceOrigin(instanceUrl: string): string | null {
  try {
    return gitlabInstanceOrigin(normalizeGitLabInstanceUrl(instanceUrl));
  } catch {
    return null;
  }
}

/** The case-insensitive exact full-path compare used by every GitLab scope check. */
function isSameProject(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Requires a GitLab identity that reaches the requested project.
 *
 * A GitLab integration belongs to an organization or a user, and its
 * connection reaches the projects of one instance. A caller without a
 * requesting account may only use `threadRepository`, the project the
 * conversation belongs to. A caller with a requesting account may use any
 * project that account's own GitLab connection reaches on the same instance.
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

  // The requester's own project list, read fresh: an account can hold more than
  // one GitLab connection, and the one that answers must be the one that reaches
  // this project on this instance. A stale snapshot would keep a membership that
  // has since been removed, so the read is not served from the cache.
  const requesterRepositories = await fetchGitLabRepositoriesForUser(requesterUserId, true);
  if (
    !requesterRepositories.integrationInstalled ||
    !requesterRepositories.repositories.some(repository =>
      isSameProject(repository.fullName, project)
    )
  ) {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }

  const projectOrigin = instanceOrigin(projectInstanceUrl);
  // The requester's connection must be readable and on the session's instance:
  // the result carries the instance it was read from, so an unreadable value
  // leaves the comparison unanswered, never allowed.
  const requesterOrigin = requesterRepositories.instanceUrl
    ? instanceOrigin(requesterRepositories.instanceUrl)
    : null;
  if (!projectOrigin || !requesterOrigin) {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }
  if (requesterOrigin !== projectOrigin) {
    return { allowed: false, markdown: instanceMismatchMarkdown(project) };
  }

  return { allowed: true };
}
