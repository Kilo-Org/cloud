import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { getGitLabIntegrationUrl } from '@/lib/integration-urls';
import { openAuthorizationAndWaitForReturn } from '@/lib/pr-review/connect-gate-platform';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { isPersonal } from './use-code-reviewer';

/**
 * Opens the provider settings page where installation access is widened. The
 * picker only ever shows what the integration may read, so this action is the
 * way to make more repositories appear; Bitbucket has no such page and gets
 * `undefined`.
 *
 * The promise resolves when the user is back from the page: Android opens a
 * custom tab that returns on the next foreground, while iOS presents the page
 * in an in-app browser that never leaves the foreground and reports its own
 * dismissal. Callers resync after the await rather than only on AppState.
 */
export function useManageRepositoryAccess(
  scope: string,
  platform: ReviewerPlatform
): (() => Promise<void>) | undefined {
  const { t } = useTranslation();
  const orgScope = isPersonal(scope) ? undefined : scope;

  const openManageAccess = useCallback(async () => {
    const label = t('codeReviewer.repos.repositoryAccess');
    const openSettings = async (url: string) => {
      try {
        await openAuthorizationAndWaitForReturn(url);
      } catch {
        // A failed launch is reported here, and the caller still resyncs: the
        // settings page may have been changed in an earlier visit.
        toast.error(t('common.couldNotOpen', { label }));
      }
    };

    if (platform === 'github') {
      try {
        const { token } = await trpcClient.githubApps.mintInstallState.mutate({
          organizationId: orgScope ?? undefined,
          returnTo: '/cloud/sessions',
        });
        await openSettings(getGitHubIntegrationUrl(WEB_BASE_URL, orgScope, token));
      } catch (error) {
        // A non-multi-installation organization that already has an active
        // GitHub App connection rejects the mint, so a pre-minted token cannot
        // exist. The settings page still works without one: it mints its own
        // state for the signed-in web user.
        const code = readTrpcErrorField(error, 'code');
        if (code === 'FORBIDDEN' && orgScope) {
          await openSettings(getGitHubIntegrationUrl(WEB_BASE_URL, orgScope));
          return;
        }
        toast.error(t('prReview.couldNotOpenGitHubAppSettings'));
      }
    } else if (platform === 'gitlab') {
      await openSettings(getGitLabIntegrationUrl(WEB_BASE_URL, orgScope));
    }
  }, [orgScope, platform, t]);

  return platform === 'bitbucket' ? undefined : openManageAccess;
}
