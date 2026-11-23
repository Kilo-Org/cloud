import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { appShellHandoffUrl } from '@/lib/app-shell-handoff';
import { bitbucketConnectHref } from '@/lib/bitbucket-connect-navigation';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { launchConnectGateBrowser } from '@/lib/pr-review/connect-gate-platform';
import { type ProviderPrPlatform } from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';

export type ReconnectHandoffInput = {
  readonly platform: ProviderPrPlatform;
  readonly organizationId: string | null;
  /** Refresh the surface's own status once the browser closes; may stay pending. */
  readonly onReturn?: () => void;
};

export type ReconnectHandoff = {
  readonly busy: boolean;
  readonly reconnect: () => void;
};

/**
 * The provider reconnection every PR-review surface shares: GitHub mints its
 * user authorization, GitLab mints the shell integration page, and Bitbucket
 * has no browser round trip at all — its token is pasted in the app's own
 * sheet, so the hand-off is a push onto that route.
 *
 * One attempt runs at a time. A second press aborts the attempt still waiting,
 * so its late report cannot speak for the new one, and unmounting aborts it too.
 */
export function useReconnectHandoff(input: ReconnectHandoffInput): ReconnectHandoff {
  const trpc = useTRPC();
  const { t } = useTranslation();
  const pushOnce = useSinglePushRoute();
  // Only the GitHub branch mints, but a hook cannot be conditional on it.
  const connect = useMutation(
    trpc.githubApps.connectUserAuthorization.mutationOptions({
      onError: error => {
        toast.error(error.message);
      },
    })
  );
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function openInBrowser(controller: AbortController): Promise<void> {
    const launch = (authorizationUrl: string) =>
      launchConnectGateBrowser(authorizationUrl, {
        signal: controller.signal,
        onOpenFailure: () => void toast.error(t('authErrors.couldNotOpenBrowser')),
        onReturn: () => {
          input.onReturn?.();
          return Promise.resolve();
        },
      });

    try {
      if (input.platform === 'github') {
        const result = await connect.mutateAsync();
        await launch(result.authorizationUrl);
        return;
      }
      // GitLab's OAuth callback lands on the web, so its connection stays a
      // hand-off: mint the shell integration page's single-use URL, then let
      // the surface re-check its own status when the browser closes.
      await launch(
        await appShellHandoffUrl({
          page: 'integration',
          platform: 'gitlab',
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        })
      );
    } catch {
      // A GitHub mutation toasted its own server error, and the launcher reports
      // a failed open through `onOpenFailure`; only a GitLab mint fails with
      // nothing else to report it.
      if (input.platform === 'gitlab' && !controller.signal.aborted) {
        void toast.error(t('authErrors.couldNotOpenBrowser'));
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  const reconnect = (): void => {
    if (input.platform === 'bitbucket') {
      if (input.organizationId === null) {
        return;
      }
      // The connect sheet changes the same status these surfaces read, so its
      // own invalidation is what closes them; nothing else runs on return.
      pushOnce(bitbucketConnectHref(input.organizationId));
      return;
    }
    // A retry supersedes the attempt still waiting: abort it first, so its late
    // report cannot speak for this one.
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    void openInBrowser(controller);
  };

  return { busy, reconnect };
}
