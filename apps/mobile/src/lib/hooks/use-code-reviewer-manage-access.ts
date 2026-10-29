import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import { WEB_BASE_URL } from '@/lib/config';
import { getGitLabIntegrationUrl } from '@/lib/integration-urls';
import {
  type AuthorizationWait,
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { isPersonal } from './use-code-reviewer';

/**
 * The picker's Manage access control: the tap handler plus the busy state the
 * tap itself owes.
 */
export type ManageRepositoryAccess = {
  /** Mints an install state and hands the user to the provider's settings page. */
  handlePress: () => void;
  /**
   * True from the tap until the browser wait settles. The control draws its
   * busy state from it, so a slow mint is never an inert button, and a second
   * tap in that window starts nothing.
   */
  pending: boolean;
};

type ManageRepositoryAccessHandlers = {
  /** A launch is starting, before the install state is minted. */
  onOpen?: () => void;
  /** The browser wait settled: the user is back, or the launch never opened. */
  onReturn?: () => void;
};

/**
 * Opens the provider settings page where installation access is widened. The
 * picker only ever shows what the integration may read, so this action is the
 * way to make more repositories appear; Bitbucket has no such page and gets
 * `undefined`.
 *
 * The wait settles when the user is back from the page: Android opens a custom
 * tab that returns on the next foreground, while iOS presents the page in an
 * in-app browser that never leaves the foreground and reports its own
 * dismissal. `onReturn` covers that edge, so a caller resyncs even when no
 * foreground event arrives.
 *
 * Every step reports itself: the busy state covers the mint, a launch that
 * fails to open toasts, and a launch that fails after the app's own return edge
 * ended the wait toasts too, because that is the one case where the user would
 * otherwise watch nothing happen.
 */
export function useManageRepositoryAccess(
  scope: string,
  platform: ReviewerPlatform,
  handlers: ManageRepositoryAccessHandlers = {}
): ManageRepositoryAccess | undefined {
  const { t } = useTranslation();
  const orgScope = isPersonal(scope) ? undefined : scope;
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const { onOpen, onReturn } = handlers;

  const open = useCallback(async () => {
    const label = t('codeReviewer.repos.repositoryAccess');
    const couldNotOpen = () => {
      toast.error(t('common.couldNotOpen', { label }));
    };
    const launch = async (url: string): Promise<AuthorizationWait | undefined> => {
      try {
        return await openAuthorizationAndWaitForReturn(url);
      } catch {
        // A failed launch is reported here, and the caller still resyncs: the
        // settings page may have been changed in an earlier visit.
        couldNotOpen();
        return undefined;
      }
    };
    const openSettings = async (url: string) => {
      const wait = await launch(url);
      if (!wait) {
        return;
      }
      // A foreground return can settle the wait before the browser reports. A
      // launch that failed after that point never reached the catch above.
      reportLateLaunchFailure(wait, { onFailure: couldNotOpen });
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

  const handlePress = useCallback(() => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setPending(true);
    onOpen?.();
    void (async () => {
      try {
        await open();
      } finally {
        inFlight.current = false;
        setPending(false);
        onReturn?.();
      }
    })();
  }, [onOpen, onReturn, open]);

  return platform === 'bitbucket' ? undefined : { handlePress, pending };
}
