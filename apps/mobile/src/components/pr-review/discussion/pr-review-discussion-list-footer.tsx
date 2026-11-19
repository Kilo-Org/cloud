// The Discussion list's footer: the cut-conversation notice, the later-page
// retry row and the Load more button, in that order. Extracted from
// pr-review-discussion-list.tsx so the list stays under the max-lines cap; the
// list still mounts it in both the normal and the filtered-empty branch.

import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ExternalLink } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { openExternalUrl } from '@/lib/external-link';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type ProviderPrRef,
  providerPrWebUrl,
  useProviderPrWebUrl,
} from '@/lib/pr-review/provider-pr-ref';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

export type ListFooterProps = {
  readonly prRef: ProviderPrRef;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly laterPageError: boolean;
  /**
   * How many conversation comments the first page carried when the server cut
   * the conversation at its page ceiling. Absent or null means the discussion
   * is complete, so no notice renders. The tab owns the number: a notice that
   * stated a count of its own would be a second, drifting fact.
   */
  readonly truncatedConversationCount?: number | null;
  readonly onLoadMore: () => void;
  readonly onRetryLoadMore: () => void;
};

export function ListFooter({
  prRef,
  hasNextPage,
  isFetchingNextPage,
  laterPageError,
  truncatedConversationCount,
  onLoadMore,
  onRetryLoadMore,
}: Readonly<ListFooterProps>) {
  // The footer is the last list content, so it owns the bottom clearance
  // that keeps the final row and every next action above the system bar.
  const { t } = useTranslation();
  const paddingBottom = useDetailScreenBottomPadding();
  const truncatedCount = truncatedConversationCount ?? 0;

  // Above Load more, so the notice reads as part of the discussion's own end
  // and never hides the button that continues it.
  const notice =
    truncatedCount > 0 ? (
      <TruncatedConversationNotice count={truncatedCount} prRef={prRef} />
    ) : null;

  if (laterPageError) {
    return (
      <View className="items-center gap-2 px-4 pt-2" style={{ paddingBottom }}>
        {notice}
        <Text variant="muted" className="text-center text-xs">
          {t('prReview.discussion.couldNotLoadMore')}
        </Text>
        <Button
          size="sm"
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={onRetryLoadMore}
          accessibilityLabel={t('prReview.discussion.retryLoadingMore')}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      </View>
    );
  }
  if (!hasNextPage) {
    // A cut conversation still has more to read, on the provider's own page,
    // so the notice replaces the bare spacer instead of disappearing with the
    // Load more button.
    if (notice !== null) {
      return (
        <View className="items-center px-4 pt-2" style={{ paddingBottom }}>
          {notice}
        </View>
      );
    }
    return <View style={{ height: paddingBottom }} />;
  }
  return (
    <View className="items-center px-4 pt-2" style={{ paddingBottom }}>
      {notice}
      <Button
        size="sm"
        variant="outline"
        loading={isFetchingNextPage}
        onPress={onLoadMore}
        accessibilityLabel={t('prReview.discussion.loadMoreComments')}
      >
        <Text>{t('common.loadMore')}</Text>
      </Button>
    </View>
  );
}

/**
 * The server's conversation ceiling notice: how much of the discussion the app
 * has, and the one place the rest of it is reachable. The count is what the
 * list actually carries, so it stays true if the ceiling moves.
 */
function TruncatedConversationNotice({
  count,
  prRef,
}: Readonly<{ count: number; prRef: ProviderPrRef }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const serverWebUrl = useProviderPrWebUrl();
  // GitHub and Bitbucket host every repository, so the ref alone is the whole
  // URL; GitLab needs the instance the read resolved, which is the published
  // one. The GitHub arm publishes null on purpose, so reading the context
  // alone would leave the one recovery affordance off the GitHub surface.
  const prUrl = providerPrWebUrl({ ref: prRef, serverWebUrl });
  const label = t('common.viewOnGitHub');
  return (
    <View className="w-full items-center gap-2">
      <Text variant="muted" className="text-center text-xs">
        {t('prReview.discussion.conversationTruncated', {
          count,
          displayCount: formatNumber(count, i18n.language),
        })}
      </Text>
      {prUrl === null ? null : (
        <Button
          size="sm"
          variant="outline"
          className={STATE_ACTION_CLASS}
          onPress={() => {
            void openExternalUrl(prUrl, { label });
          }}
          accessibilityLabel={label}
        >
          <View className="flex-row items-center gap-2">
            <ExternalLink size={14} color={colors.foreground} />
            <Text>{label}</Text>
          </View>
        </Button>
      )}
    </View>
  );
}
