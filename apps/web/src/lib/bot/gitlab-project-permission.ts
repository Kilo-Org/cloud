import 'server-only';
import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { getAllIntegrationsForOwner } from '@/lib/integrations/db/platform-integrations';
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
 * Why a requester has no connection that can answer for the project: the
 * account holds no usable GitLab connection, or it holds connections that all
 * reach another instance.
 */
type GitLabConnectionRefusal = { matched: false; reason: 'projectAccess' | 'instanceMismatch' };

type RequesterGitLabConnection = { matched: true; token: string } | GitLabConnectionRefusal;

/**
 * The requester's own GitLab connection for the project's instance, with the
 * credential it stores. A row is usable only when it is healthy: a suspended or
 * reauthorization-required row cannot answer for the account. One account may
 * hold several rows, one per instance, so the rows are read together and the
 * row whose stored instance equals `projectInstance` is used. A row whose
 * stored instance cannot be normalized is skipped. A definitive credential
 * refusal is `projectAccess`; every other failure propagates, so the caller
 * answers one retry reply and captures the error instead of reporting it as
 * this account's access.
 */
async function requesterGitLabConnection(
  requesterUserId: string,
  projectInstance: string
): Promise<RequesterGitLabConnection> {
  const integrations = await getAllIntegrationsForOwner({ type: 'user', id: requesterUserId });
  const healthy = integrations.filter(
    integration =>
      integration.platform === PLATFORM.GITLAB && isPlatformIntegrationHealthy(integration)
  );

  const integration = healthy.find(row => {
    try {
      return normalizeGitLabInstanceUrl(readInstanceUrl(row)) === projectInstance;
    } catch {
      return false;
    }
  });
  if (!integration) {
    return { matched: false, reason: healthy.length === 0 ? 'projectAccess' : 'instanceMismatch' };
  }

  try {
    const token = await getValidGitLabToken(integration, { userId: requesterUserId });
    return { matched: true, token };
  } catch (error) {
    if (!isGitLabCredentialRefusal(error)) throw error;
    return { matched: false, reason: 'projectAccess' };
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

  // The project's instance is read once. Comparing the normalized URLs, base
  // path included, keeps two self-managed instances apart that share a host. An
  // unreadable value leaves the instance unanswered, never allowed.
  let projectInstance: string;
  try {
    projectInstance = normalizeGitLabInstanceUrl(projectInstanceUrl);
  } catch {
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }

  // One row supplies both the instance and the credential, so the access read
  // cannot pair an instance from one connection with a token from another.
  const connection = await requesterGitLabConnection(requesterUserId, projectInstance);
  if (!connection.matched) {
    return {
      allowed: false,
      markdown:
        connection.reason === 'instanceMismatch'
          ? instanceMismatchMarkdown(project)
          : projectAccessRequiredMarkdown(project),
    };
  }

  // Write access is read with the requester's own credential, so the answer
  // covers the project the session will use on this instance. A credential the
  // provider rejects answers the access copy, because mentioning the bot again
  // cannot change it; every other failure propagates to the caller's retry
  // reply.
  let accessLevel: number | null;
  try {
    accessLevel = await fetchGitLabProjectAccessLevel(connection.token, project, projectInstance);
  } catch (error) {
    if (!isGitLabCredentialRefusal(error)) throw error;
    return { allowed: false, markdown: projectAccessRequiredMarkdown(project) };
  }
  if (accessLevel === null || accessLevel < GITLAB_ACCESS_LEVELS.DEVELOPER) {
    return { allowed: false, markdown: projectWriteAccessRequiredMarkdown(project) };
  }

  return { allowed: true };
}
