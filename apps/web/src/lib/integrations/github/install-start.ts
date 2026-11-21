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
import { getOrganizationGitHubInstallationSlots } from '@/lib/integrations/db/platform-integrations';
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
    // An organization that is not entitled to multiple installations holds one
    // installation slot, and every writer that makes a GitHub association the
    // workflow connection refuses a second installation. Starting an install
    // reads the same live associations, so an organization is not sent to
    // install something the completion would refuse. A pending request carries
    // no installation id yet, and a locally disconnected association has
    // relinquished its slot, so neither blocks the page; a suspended or
    // auth-invalid association still holds its slot until it is disconnected.
    //
    // This read answers the common case before the install page opens. It is
    // not the admission check for the rule: each writer applies the rule
    // under the owner's installation slot lock, so the stored slot count
    // follows the rule whatever order the requests arrive in.
    const slots = await getOrganizationGitHubInstallationSlots(owner.id);
    if (slots.some(slot => slot.installationId !== null)) {
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
