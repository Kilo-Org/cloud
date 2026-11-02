import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { gitlabInstanceMismatch } from '@/lib/pr-review/pr-review-connect-gate-view';
import { useProviderPrScopeOrNull } from '@/lib/pr-review/provider-pr-ref';
import { useCheckProviderConnection } from '@/lib/pr-review/use-check-provider-connection';
import { useTRPC } from '@/lib/trpc';

/**
 * Recovery actions for a provider PR/MR surface's terminal-looking
 * "unavailable" state. GitLab folds its connection failures (no integration,
 * inactive integration, an instance other than the connected one) into the
 * same NOT_FOUND a deleted merge request produces, and Bitbucket does the same
 * for its workspace failures, so the state cannot tell the two apart. A retry
 * re-runs the read; the connection check re-reads the integration status and,
 * when connected, invalidates `providerReview` so every surface below it
 * refetches.
 *
 * The check always ends in a visible outcome. When the connection cannot serve
 * this item — none at all, or one on another GitLab instance — the gate above
 * re-decides from the refreshed status and replaces this surface. When the
 * connection is usable the refetched reads decide: an item that loads replaces
 * this surface with itself, and one that still fails is answered by the toast
 * below instead of a tap that looks dead.
 *
 * Renders nothing on a GitHub scope: GitHub's not-found has its own install
 * CTA and its connectivity is the GitHub App authorization, not an
 * integration status this hook can check.
 */
export function PrReviewUnavailableActions({
  onRetry,
  isRetrying,
}: Readonly<{
  onRetry: () => void;
  isRetrying: boolean;
}>) {
  const { t } = useTranslation();
  const scope = useProviderPrScopeOrNull();
  const providerConnection = useCheckProviderConnection();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const providerPlatform =
    scope === null || scope.ref.platform === 'github' ? null : scope.ref.platform;

  // The settled answer, not the press, decides what the reader sees: a usable
  // connection leaves this surface only if the item still cannot be read, and
  // an unusable one is answered by the gate that replaces this surface on the
  // refreshed status.
  async function checkConnection() {
    if (providerPlatform === null) {
      return;
    }
    // The reads that made this surface the unavailable one. Captured before
    // the check, because the check clears their errors as it refetches them,
    // and a read that now answers with data is the item itself.
    const unavailableKeys = queryClient
      .getQueryCache()
      .findAll({
        queryKey: trpc.providerReview.pathFilter().queryKey,
        type: 'active',
        predicate: query => query.state.status === 'error',
      })
      .map(query => query.queryKey);
    try {
      const status = await providerConnection.mutateAsync({
        platform: providerPlatform,
        organizationId: scope?.organizationId ?? null,
      });
      if (!status.connected) {
        return;
      }
      // The same origin comparison the review read makes: a connection to
      // another instance cannot serve this merge request, and the gate names
      // that instead of this surface.
      const mismatch =
        providerPlatform === 'gitlab' && scope?.ref.platform === 'gitlab'
          ? gitlabInstanceMismatch({
              instanceHint: scope.ref.instanceHint,
              connectedInstanceUrl: status.instanceUrl ?? undefined,
            })
          : null;
      if (mismatch !== null) {
        return;
      }
      // The hook awaited the refetch of those reads. When every one of them
      // settled successfully, the item replaced this surface and the reader is
      // looking at it, so a toast claiming it still cannot load would
      // contradict the screen. The state, not the presence of data, decides:
      // a failed refetch of a read that once succeeded keeps its old data, and
      // this surface is still the one on screen.
      const itemLoaded =
        unavailableKeys.length > 0 &&
        unavailableKeys.every(key => {
          const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
          return query?.state.status === 'success' && query.state.data !== undefined;
        });
      if (itemLoaded) {
        return;
      }
      toast(t('prReview.connect.checkActiveConnection'));
    } catch {
      // A failed check is the hook's own error toast; nothing here claims the
      // connection is fine.
    }
  }

  if (!providerPlatform) {
    return null;
  }

  return (
    <View className="mt-3 w-full gap-2">
      <Button
        className={STATE_ACTION_CLASS}
        variant="outline"
        onPress={onRetry}
        loading={isRetrying}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
      <Button
        className={STATE_ACTION_CLASS}
        variant="outline"
        onPress={() => {
          void checkConnection();
        }}
        loading={providerConnection.isPending}
        accessibilityLabel={t('prReview.checkConnection')}
      >
        <Text>{t('prReview.checkConnection')}</Text>
      </Button>
    </View>
  );
}
