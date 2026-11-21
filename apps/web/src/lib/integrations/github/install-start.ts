import 'server-only';
import { TRPCError } from '@trpc/server';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  getGitHubAppName,
  getGitHubAppTypeForOrganization,
} from '@/lib/integrations/platforms/github/app-selector';
import { resolveAuthorizedOwner } from '@/lib/integrations/resolve-owner';
import { canOrganizationUseMultipleGitHubInstallations } from '@/lib/integrations/github/multiple-installations';
import { getPrimaryGitHubIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { createInstallState } from '@/lib/integrations/github/install-state';

/**
 * Mints the single-use install state that starts a GitHub App installation.
 *
 * One implementation serves both entry points: the web tRPC mutation and the
 * app shell's own start route, which must set the shell flow cookie on the same
 * response that starts the install.
 */
export async function beginGitHubAppInstall(
  ctx: Pick<TRPCContext, 'user'>,
  input: { organizationId?: string; returnTo: string | null }
): Promise<{ token: string; appType: GitHubAppType }> {
  const owner = await resolveAuthorizedOwner(
    ctx,
    input.organizationId,
    input.organizationId ? ORGANIZATION_MANAGE_ROLES : undefined
  );

  if (owner.type === 'org' && !canOrganizationUseMultipleGitHubInstallations(owner.id)) {
    // The single-installation slot belongs to the organization's live
    // workflow connection. Anything else still leaves the slot free to
    // start an installation from: a pending request awaiting a GitHub
    // organization admin's approval carries no installation id yet, and a
    // suspended association is a connection GitHub will not serve until it
    // is restored, so neither is a reason to refuse the install page. A
    // locally disconnected row keeps relinquishing its slot, which the
    // connection's health predicate already expresses.
    const workflowConnection = await getPrimaryGitHubIntegrationForOrganization(owner.id);
    if (workflowConnection) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This organization already has a GitHub installation',
      });
    }
  }

  const appType = await getGitHubAppTypeForOrganization(input.organizationId ?? null);
  const token = await createInstallState({
    kiloUserId: ctx.user.id,
    ownerType: owner.type,
    ownerId: owner.id,
    githubAppType: appType,
    returnTo: input.returnTo,
  });

  return { token, appType };
}

/** The GitHub page an install state is handed to. */
export function buildGitHubAppInstallUrl(token: string, appType: GitHubAppType): string {
  return `https://github.com/apps/${getGitHubAppName(appType)}/installations/new?state=${encodeURIComponent(token)}`;
}
