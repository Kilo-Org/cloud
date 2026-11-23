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
import {
  listOrganizationGitHubInstallationSlots,
  type OrganizationGitHubInstallationSlot,
} from '@/lib/integrations/db/platform-integrations';
import { holdsGitHubInstallationSlot } from '@/lib/integrations/db/predicates';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { createInstallState } from '@/lib/integrations/github/install-state';

/**
 * Why the install page is refused for an organization that holds its single
 * installation slot, or null when the slot is free.
 *
 * An organization may start an installation only when the completion gate
 * would accept one: `connectVerifiedGitHubInstallation` refuses a second
 * installation while any association that is not locally disconnected holds the
 * slot, and refuses an installation whose canonical record is suspended. The
 * start gate therefore reads the same associations, so a user is never sent to
 * GitHub to create an installation that completion then rejects. The message
 * names the recovery the organization already has: restore the connection on
 * GitHub, or disconnect it in Kilo.
 */
export function describeGitHubInstallStartRefusal(
  slots: readonly OrganizationGitHubInstallationSlot[]
): string | null {
  const occupied = slots.filter(holdsGitHubInstallationSlot);
  if (occupied.length === 0) return null;
  return occupied.every(isPlatformIntegrationHealthy)
    ? 'This organization already has a GitHub installation. Disconnect it before installing another.'
    : "This organization's GitHub connection is suspended or needs attention. Restore or disconnect it before installing again.";
}

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
    const refusal = describeGitHubInstallStartRefusal(
      await listOrganizationGitHubInstallationSlots(owner.id)
    );
    if (refusal) {
      throw new TRPCError({ code: 'FORBIDDEN', message: refusal });
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
