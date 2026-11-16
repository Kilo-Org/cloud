import { isPersonalSecurityScope } from '@kilocode/app-shared/security-agent';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { isInstallStateRefusal } from '@/components/security-agent/scope-entry-render';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { trpcClient } from '@/lib/trpc';

type UseRepositoryAccessOptions = {
  /** The security scope whose installation access this screen widens. */
  scope: string;
  /** Reads the repository list again once a settings page has opened. */
  refetch: () => Promise<void>;
};

/**
 * Widening the app's GitHub installation access from the repository picker.
 *
 * The GitHub settings page is where installation access is widened on the web,
 * and `openExternalUrl` resolves when that page closes — on both platforms it
 * awaits the browser's own dismissal (a launch it could not open is toasted by
 * that helper and still resolves). Reading the repository list again on that
 * return edge is what makes a grant show up in the picker: without it the cached
 * empty answer stays fresh for the whole stale window, and the disabled agent's
 * enable rule counts exactly these repositories.
 *
 * The mint is only the hand-off token. An organization's mint is limited to the
 * roles that manage the organization, so the server can answer that this reader
 * may not start one. That answer is reported as `accessRefused` and opens
 * nothing: the notice then stands where the control was and names who can. Every
 * other organization failure — `FORBIDDEN`, transport errors — still falls back
 * to the plain settings URL, because that page mints its own state for the
 * signed-in user. A personal mint failure has no such page-level fallback to
 * reach, so it keeps the toast.
 */
export function useRepositoryAccess({ scope, refetch }: UseRepositoryAccessOptions) {
  const { t } = useTranslation();
  // Set when the server's answer is that this reader may not start an
  // installation for the scope. The notice then stands where the action was.
  const [accessRefused, setAccessRefused] = useState(false);

  const manageAccess = async () => {
    const orgId = isPersonalSecurityScope(scope) ? undefined : scope;
    const open = async (url: string) => {
      await openExternalUrl(url, {
        label: t('securityAgent.repositories.githubAppSettings'),
      });
    };
    try {
      const { token } = await trpcClient.githubApps.mintInstallState.mutate({
        organizationId: orgId ?? undefined,
        returnTo: '/cloud/sessions',
      });
      await open(getGitHubIntegrationUrl(WEB_BASE_URL, orgId, token));
    } catch (error) {
      if (!orgId) {
        toast.error(t('prReview.couldNotOpenGitHubAppSettings'));
        return;
      }
      if (isInstallStateRefusal(error)) {
        setAccessRefused(true);
        return;
      }
      await open(getGitHubIntegrationUrl(WEB_BASE_URL, orgId));
    }
    await refetch();
  };

  return { accessRefused, manageAccess };
}
