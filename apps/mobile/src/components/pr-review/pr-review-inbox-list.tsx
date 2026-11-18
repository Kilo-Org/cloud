// PR inbox list: the entry screen's single scroll container.
//
// The screen keeps its ScreenHeader and the paste-a-link + recents
// state; this component owns the ONE FlashList that composes the whole
// body. The paste block and recents are passed in and rendered in the
// list header/footer so they stay mounted in every inbox state (E4/E5
// depend on reaching Recents right after a failed open). Inbox states
// render inside `ListEmptyComponent` — never as a replacement for the
// screen.

import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrReviewReconnectNotice } from '@/components/pr-review/pr-review-reconnect-notice';
import { InboxEmpty } from '@/components/pr-review/pr-review-inbox-empty';
import {
  isOrganizationAccessView,
  selectPrInboxView,
} from '@/components/pr-review/pr-review-inbox-view';
import { Button } from '@/components/ui/button';
import { RowChevron } from '@/components/ui/row-chevron';
import { SectionHeader } from '@/components/ui/section-header';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useOrganization } from '@/lib/organization-context';
import { useRelativeTimeNow } from '@/lib/hooks/use-now-ticker';
import {
  providerPrRefLabel,
  providerPrRoutePath,
  providerPrTermKey,
} from '@/lib/pr-review/provider-pr-ref';
import { type ProviderInboxRow, useProviderInbox } from '@/lib/pr-review/use-provider-inbox';
import { parseTimestamp, timeAgo } from '@/lib/utils';

type InboxItem = ProviderInboxRow;

/**
 * The two spacings every section of this screen shares.
 *
 * The INBOX header follows the paste block (and its own reserved link-error
 * line) and the RECENT header follows the inbox body; the two breaks are the
 * same section-to-section relation, so they share one token instead of each
 * picking its own: the layout contract's 21pt section gap. A header is closer
 * to its own content than to the section above it (`gap-3`, 10.5pt) — otherwise
 * the gap under a body reads as its spacing and the eyebrow looks like the last
 * line of the block it follows.
 */
const PR_REVIEW_SECTION_BREAK = { padding: 'pt-6' } as const;
const PR_REVIEW_SECTION_LABEL_GAP = 'gap-3';

type PrReviewInboxListProps = {
  /**
   * The "Paste a PR link" block, rendered above the Inbox eyebrow and ending
   * in its own reserved link-error slot. The list applies the section break
   * above the eyebrow, so the paste block does not carry one.
   */
  header: ReactNode;
  /** The recents body, rendered below the pagination footer. */
  recents: ReactNode;
};

export function PrReviewInboxList({ header, recents }: Readonly<PrReviewInboxListProps>) {
  const inbox = useProviderInbox(true);
  const { organizationId, setOrganizationId } = useOrganization();
  // Two different retries, because they recover two different failures: the
  // empty-state CTA re-runs the inbox from scratch, while the footer CTA must
  // load only the page (or the provider) that failed — re-fetching pages the
  // list already shows would never load the missing one.
  const handleRetry = () => {
    inbox.refetch();
  };
  const handleRetryMore = () => {
    inbox.retryFailedPages();
  };
  // The refused organization's own reads cannot succeed, so the escape is the
  // personal scope: the same selection the account picker makes.
  const handleContinueInPersonal = () => {
    setOrganizationId(null);
  };
  const reconnectOnly = inbox.githubNeedsReconnect && !inbox.isPending && inbox.items.length === 0;
  const view = selectPrInboxView({
    isPending: inbox.isPending,
    isFetching: inbox.isFetching,
    itemCount: inbox.items.length,
    firstPageErrorState:
      inbox.firstPageErrorState ?? (reconnectOnly ? { kind: 'reconnect' } : null),
    laterPageError: inbox.laterPageError,
    organizationScopeAccess: inbox.organizationScopeAccess,
  });
  // A provider outage that left the merged list empty is the retryable view
  // itself (`selectPrInboxView`), so the empty state can no longer sit beside
  // this footer. Only the reconnect notice stays a first-page state: a provider
  // that also failed beside it keeps the inline retry for its own page.
  const showLoadMoreRetry =
    view.showLoadMoreRetry || (view.kind === 'reconnect' && inbox.laterPageError);

  // Landscape: the side insets keep the rows and the header content clear of
  // the sensor housing; portrait insets are zero. The page gutter itself is
  // drawn by the rows and the header block, not by the content container.
  const insets = useSafeAreaInsets();
  const contentContainerStyle = useMemo<ViewStyle>(
    () => ({ paddingLeft: insets.left, paddingRight: insets.right }),
    [insets.left, insets.right]
  );

  return (
    <FlashList
      data={view.kind === 'happy' ? inbox.items : []}
      keyExtractor={item => item.key}
      renderItem={({ item }) => <InboxRow item={item} />}
      ListHeaderComponent={
        <View className="px-4 pt-3">
          {header}
          <View className={PR_REVIEW_SECTION_BREAK.padding}>
            <InboxEyebrow />
          </View>
        </View>
      }
      ListEmptyComponent={
        <InboxEmpty
          view={view}
          onRetry={handleRetry}
          isRetrying={inbox.isFetching}
          reconnectPlatform={inbox.firstPageErrorPlatform}
          organizationId={organizationId}
          onContinueInPersonal={handleContinueInPersonal}
        />
      }
      ListFooterComponent={
        // RECENT waits for the inbox to settle. While the skeletons are up the
        // section would sit under a placeholder that is taller than most
        // settled bodies, so the section either reserves that air (and lands
        // under the tab bar on a compact phone) or jumps up when the inbox
        // settles. Left out, nothing below the skeletons can move, and the
        // section appears at the height the settled body leaves it.
        view.kind === 'loading' ? null : (
          <View className={`gap-6 px-4 pb-12 ${PR_REVIEW_SECTION_BREAK.padding}`}>
            {inbox.githubNeedsReconnect &&
            view.kind !== 'reconnect' &&
            !isOrganizationAccessView(view) ? (
              <PrReviewReconnectNotice />
            ) : null}
            {showLoadMoreRetry ? <LoadMoreRetry onRetry={handleRetryMore} /> : null}
            <View className={PR_REVIEW_SECTION_LABEL_GAP}>
              <RecentEyebrow />
              {recents}
            </View>
          </View>
        )
      }
      onEndReached={() => {
        if (inbox.hasNextPage && !inbox.isFetchingNextPage) {
          inbox.fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.5}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
    />
  );
}

function InboxEyebrow() {
  const { t } = useTranslation();
  return <SectionHeader label={t('prReview.inbox.title')} />;
}

function RecentEyebrow() {
  const { t } = useTranslation();
  return <SectionHeader label={t('common.recent')} />;
}

function InboxRow({ item }: Readonly<{ item: InboxItem }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const now = useRelativeTimeNow();
  const updatedLabel = timeAgo(parseTimestamp(item.updatedAt), undefined, now);
  // `group/sub/repo!12` on GitLab, `owner/repo#7` elsewhere — the row says
  // which provider it came from before the term chip repeats it in words.
  const rowLabel = providerPrRefLabel(item.ref);

  return (
    <Pressable
      onPress={() => {
        router.push(providerPrRoutePath(item.ref));
      }}
      accessibilityRole="button"
      accessibilityLabel={rowLabel}
      className="flex-row items-center gap-3 border-b-[0.5px] border-hair-soft px-4 py-3 active:opacity-70"
    >
      <View className="flex-1 gap-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {item.title}
        </Text>
        <View className="flex-row items-center gap-2">
          {/* The ref · age is the row's flexible value: without `min-w-0 shrink`
              it takes the whole row, pushing the chip past the right edge where
              the row clips it (pr-review-home, font scale 2) — and a nested
              GitLab path or a long owner/repo (#2
              `discussion-conversation-only`) is wider than the row, so the
              row's own gutter clips the pill to "Pull re" and hides its rounded
              end.
              Truncate the metadata to one line instead; the chip is the row's
              identity and must stay whole. Same pattern as `PrRefsRow` in
              pr-review-overview-parts.tsx. */}
          <Text variant="muted" className="min-w-0 shrink text-xs" numberOfLines={1}>
            {rowLabel} · {updatedLabel}
          </Text>
          <InboxChip label={t(providerPrTermKey(item.ref.platform))} />
          {item.isDraft ? <InboxChip label={t('common.draft')} /> : null}
        </View>
      </View>
      <RowChevron />
    </Pressable>
  );
}

function InboxChip({ label }: Readonly<{ label: string }>) {
  // shrink-0 keeps the chip at its label width while the row's text truncates.
  return (
    <View className="shrink-0 rounded-full bg-secondary px-2 py-0.5">
      <Text variant="muted" className="text-xs font-medium">
        {label}
      </Text>
    </View>
  );
}

function LoadMoreRetry({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useTranslation();
  return (
    <View className="items-center gap-2">
      <Text variant="muted" className="text-center text-xs">
        {t('common.couldnTLoadMore')}
      </Text>
      <Button
        size="sm"
        variant="outline"
        className={STATE_ACTION_CLASS}
        onPress={onRetry}
        accessibilityLabel={t('common.retryLoadingMore')}
      >
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}
