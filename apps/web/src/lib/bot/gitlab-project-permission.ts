import 'server-only';
import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { isGitLabReconnectRequiredError } from '@/lib/integrations/platforms/gitlab/credential-errors';
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

/**
 * Whether a credential failure is a definitive refusal: the stored connection
 * cannot answer until its owner reconnects, so mentioning the bot again cannot
 * change the answer. Only these two answers reach the access copy.
 *
 * Every other failure propagates so the caller answers its retry reply and
 * captures the error. A transport error or the broker's `SERVICE_UNAVAILABLE`
 * says nothing about the project, and neither does a rejected request or a
 * connection that changed while its credential resolved: blaming the caller's
 * access would be wrong, and an operator would not see the real fault.
 */
function isGitLabCredentialRefusal(error: unknown): boolean {
  if (isGitLabReconnectRequiredError(error)) return true;
  return error instanceof TRPCError && error.code === 'NOT_FOUND';
}

/** The instance URL a GitLab connection stores, defaulting to gitlab.com. */
function readInstanceUrl(integration: Pick<PlatformIntegration, 'metadata'>): string {
  const { metadata } = integration;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return DEFAULT_GITLAB_INSTANCE_URL;
  }
  if (!('gitlab_instance_url' in metadata)) {
    return DEFAULT_GITLAB_INSTANCE_URL;
  }
  const raw = metadata.gitlab_instance_url;
  return typeof raw === 'string' && raw ? raw : DEFAULT_GITLAB_INSTANCE_URL;
}

/**
 * The requester's own GitLab connection and the credential it stores. A row is
 * usable only when it is healthy: a suspended or reauthorization-required row
 * cannot answer for the account. A definitive credential refusal is null; every
 * other failure propagates, so the caller answers one retry reply and captures
 * the error instead of reporting it as this account's access.
 */
async function requesterGitLabConnection(
  requesterUserId: string
): Promise<{ integration: PlatformIntegration; token: string } | null> {
  const integration = await getIntegrationForOwner(
    { type: 'user', id: requesterUserId },
    PLATFORM.GITLAB
  );
  if (!integration || !isPlatformIntegrationHealthy(integration)) {
    return null;
  }

  try {
    const token = await getValidGitLabToken(integration, { userId: requesterUserId });
    return { integration, token };
  } catch (error) {
    if (!isGitLabCredentialRefusal(error)) throw error;
    return null;
  }
}

/**
 * Requires a GitLab identity that reaches the requested project with write
 * access, for organization-owned connections.
 *
 * A GitLab integration belongs to an organization or a user, and its
 * connection reaches the projects of one instance. An organization-owned
 * connection needs a recorded requester, because the conversation repository
 * is a GitHub repository and never names a GitLab project. The requester's own
 * GitLab connection must reach a project on the session's instance with write
 * access.
 *
 * A lookup that fails is not answered here: it propagates to the caller, which
 * reports it as one retry reply. Only a definitive credential refusal answers
 * the access copy.
 */
export async function authorizeGitLabProject(params: {
  /** Requested project path, `group/project` or `group/subgroup/project`. */
  project: string;
  /** Instance URL of the connection whose credential the session will use. */
  projectInstanceUrl: string;
  /** True when the session runs on an organization-owned connection's credential. */
  organizationOwned: boolean;
  /** The person who triggered this run, when the platform supplied a verified account. */
  requesterUserId?: string;
}): Promise<GitLabProjectAuthorization> {
  const { project, projectInstanceUrl, organizationOwned, requesterUserId } = params;

  // A personally owned connection is controlled by its owner, whose own
  // credential starts the session, so it needs no separate project
  // authorization.
  if (!organizationOwned) return { allowed: true };

  // An organization-owned connection has no implicit project: the conversation
  // repository is a GitHub repository, so it never names a GitLab project.
  if (!requesterUserId) {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }

  // One row supplies both the instance and the credential, so the access read
  // cannot pair an instance from one connection with a token from another.
  const connection = await requesterGitLabConnection(requesterUserId);
  if (!connection) {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }
  const requesterInstanceUrl = readInstanceUrl(connection.integration);

  // Comparing the normalized URLs, base path included, keeps two self-managed
  // instances apart that share a host. An unreadable value leaves the
  // comparison unanswered, never allowed.
  let requesterInstance: string;
  try {
    const projectInstance = normalizeGitLabInstanceUrl(projectInstanceUrl);
    requesterInstance = normalizeGitLabInstanceUrl(requesterInstanceUrl);
    if (requesterInstance !== projectInstance) {
      return { allowed: false, markdown: instanceMismatchMarkdown(project) };
    }
  } catch {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }

  // Write access is read with the requester's own credential, so the answer
  // covers the project the session will use on this instance.
  const accessLevel = await fetchGitLabProjectAccessLevel(
    connection.token,
    project,
    requesterInstance
  );
  if (accessLevel === null || accessLevel < GITLAB_ACCESS_LEVELS.DEVELOPER) {
    return { allowed: false, markdown: projectWriteAccessRequiredMarkdown(project) };
  }

  return { allowed: true };
}
