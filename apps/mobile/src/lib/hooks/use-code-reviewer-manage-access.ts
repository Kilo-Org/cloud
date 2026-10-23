import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { openExternalUrl } from '@/lib/external-link';
import { getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { isPersonal } from './use-code-reviewer';

/**
 * Opens the provider settings page where installation access is widened. The
 * picker only ever shows what the integration may read, so this action is the
 * way to make more repositories appear; Bitbucket has no such page and gets
 * `undefined`.
 */
export function useManageRepositoryAccess(
  scope: string,
  platform: ReviewerPlatform
): (() => void) | undefined {
  const { t } = useTranslation();
  const orgScope = isPersonal(scope) ? undefined : scope;

  const openManageAccess = useCallback(() => {
    void (async () => {
      if (platform === 'github') {
        try {
          const { token } = await trpcClient.githubApps.mintInstallState.mutate({
            organizationId: orgScope ?? undefined,
            returnTo: '/cloud/sessions',
          });
          await openExternalUrl(getGitHubIntegrationUrl(WEB_BASE_URL, orgScope, token), {
            label: t('codeReviewer.repos.repositoryAccess'),
          });
        } catch (error) {
          // A non-multi-installation organization that already has an active
          // GitHub App connection rejects the mint, so a pre-minted token
          // cannot exist. The settings page still works without one: it mints
          // its own state for the signed-in web user.
          const code = readTrpcErrorField(error, 'code');
          if (code === 'FORBIDDEN' && orgScope) {
            await openExternalUrl(getGitHubIntegrationUrl(WEB_BASE_URL, orgScope), {
              label: t('codeReviewer.repos.repositoryAccess'),
            });
            return;
          }
          toast.error(t('prReview.couldNotOpenGitHubAppSettings'));
        }
      } else if (platform === 'gitlab') {
        await openExternalUrl(getGitLabIntegrationUrl(WEB_BASE_URL, orgScope), {
          label: t('codeReviewer.repos.repositoryAccess'),
        });
      }
    })();
  }, [orgScope, platform, t]);

  return platform === 'bitbucket' ? undefined : openManageAccess;
}
