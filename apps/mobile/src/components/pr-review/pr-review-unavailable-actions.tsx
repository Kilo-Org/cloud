import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { toast } from 'sonner-native';

import { StateAction } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { PlugZap, RotateCcw } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
 *
 * The retry is the state's one primary, the shared `StateAction`, as on the
 * connect gate and the GitHub install CTA: it is the action that can recover
 * the item from here. The connection check stays the outlined control below
 * it, at the same compact size with its own leading icon, because it answers a
 * different question — whether the account is still connected — and a state
 * with two equally weighted buttons has no primary at all.
 *
 * That primary belongs to a whole-surface unavailable state. A caller that
 * embeds the row inside a body owning its own primary passes
 * `presentation="embedded"` instead: the retry takes the outlined face, so it
 * never competes with the body's filled primary, and the connection check keeps
 * that same outlined face instead of the quiet ghost one. Both controls then
 * paint one visible box edge, so the gap above the row and the gap inside it
 * read as the same distance; a ghost check hides its own 48pt box and the row
 * looked like one tight pair and one loose one. The row also drops the margin
 * it uses as a whole surface — the card's own gap spaces it from the copy
 * above — and spaces its two controls by that same gap.
 */
export function PrReviewUnavailableActions({
  onRetry,
  isRetrying,
  presentation = 'surface',
}: Readonly<{
  onRetry: () => void;
  isRetrying: boolean;
  /**
   * `embedded` when the surrounding body already shows its own primary action:
   * both controls on the outlined face, with no margin of its own.
   */
  presentation?: 'surface' | 'embedded';
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
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

  const embedded = presentation === 'embedded';
  return (
    <View className={embedded ? 'w-full items-center gap-3' : 'mt-3 items-center gap-2'}>
      <StateAction
        label={t('common.retry')}
        icon={RotateCcw}
        onPress={onRetry}
        loading={isRetrying}
        {...(embedded ? { variant: 'outline' as const } : {})}
      />
      <Button
        size="sm"
        className={STATE_ACTION_CLASS}
        variant="outline"
        onPress={() => {
          void checkConnection();
        }}
        loading={providerConnection.isPending}
        accessibilityLabel={t('prReview.checkConnection')}
      >
        <PlugZap size={16} color={colors.foreground} />
        <Text>{t('prReview.checkConnection')}</Text>
      </Button>
    </View>
  );
}
