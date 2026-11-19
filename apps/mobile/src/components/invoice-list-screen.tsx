import { FileText } from '@/components/ui/icons';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { type Href } from 'expo-router';
import { type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { type Invoice, InvoiceRow } from '@/components/invoice-list-row';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { RefreshControl } from '@/components/ui/refresh-control';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useManualRefresh } from '@/lib/hooks/use-manual-refresh';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { selectInvoiceErrorVariant } from '@/lib/organization-invoice-error-variant';

/**
 * What the list reads from a scope's paged invoice query. The personal and the
 * organization procedures return the same page, so the list takes the fields it
 * renders instead of either query's concrete type — the two differ in their
 * error class, which is exactly what this boundary hides.
 */
type InvoiceListQuery = {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly isFetching: boolean;
  readonly isFetchNextPageError: boolean;
  readonly isFetchingNextPage: boolean;
  readonly error: unknown;
  readonly data: { readonly pages: readonly unknown[] } | undefined;
  /**
   * The pull's read: it resolves with the settled result so the shared refresh
   * hook can decide whether to report the failure.
   */
  readonly refetch: () => Promise<{ readonly isError: boolean }>;
  readonly fetchNextPage: () => void;
};

// FlashList takes `contentContainerStyle` (no className). The rows own their
// full-bleed geometry and their hairline, so the container only carries the
// flex grow the empty state needs.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
} satisfies ViewStyle;

const SKELETON_ROW_COUNT = 3;

function InvoiceListSkeleton() {
  return (
    <View>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <RowSkeleton key={index} subtitle />
      ))}
    </View>
  );
}

type InvoiceListScreenProps = Readonly<{
  /** The screen's own title: the personal and organization lists differ. */
  title: string;
  /**
   * One muted context line under the title, the header's subtitle slot: what
   * the list covers when the title alone does not say it (the personal list's
   * fixed one-year window).
   */
  subtitle?: string;
  /**
   * The screen's own name when the title names a scope: the organization scope
   * titles itself with the membership's name, so this list's name keeps the
   * header's mono category line and a user-authored name never takes it.
   */
  eyebrow?: string;
  /**
   * Hold the eyebrow's line before a scope name resolves, so the header keeps
   * one height while the membership read settles. A caller whose title is
   * already this screen's name paints no eyebrow and leaves this off.
   */
  reserveEyebrow?: boolean;
  /** Where the header's Back lands when the list opens with no history to pop. */
  backFallback: Href;
  /** The scope's paged invoice read, flattened by its own hook. */
  query: InvoiceListQuery;
  entries: readonly Invoice[];
  hasMore: boolean;
  emptyTitle: string;
  emptyDescription: string;
  /**
   * The empty state's way out, rendered in the state's action slot: a scope
   * whose empty copy points elsewhere passes the control that opens it.
   */
  emptyAction?: ReactNode;
}>;

/**
 * The invoice list both scopes render: a person's own invoices and an
 * organization's are the same Stripe shape, so the rows, the paging footer and
 * every state live here once. A scope supplies its read and its empty copy.
 */
export function InvoiceListScreen({
  title,
  subtitle,
  eyebrow,
  reserveEyebrow,
  backFallback,
  query,
  entries,
  hasMore,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: InvoiceListScreenProps) {
  const { t } = useTranslation();
  const paddingBottom = useTabBarBottomPadding();
  const committedConnectivity = useCommittedConnectivityStatus();
  // An invoice can appear without a screen change (a renewal charging while the
  // app is open), so both bodies offer the same pull over the read.
  const [refreshing, onRefresh] = useManualRefresh(query.refetch, t('common.couldNotRefresh'));
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;

  // `InvoiceRow` is memoized at module scope, so the renderer keeps one identity
  // across data updates and only the changed rows re-render.
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<Invoice>) => (
      <InvoiceRow invoice={item} last={index === entries.length - 1} />
    ),
    [entries.length]
  );

  const isLoading = query.isPending;
  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
  const isFirstPageError = query.isError && !hasLoadedPages;

  // NOT_FOUND maps to the not-found state; FORBIDDEN/UNAUTHORIZED map to the
  // permission state. A read that settled by failing on a confirmed-offline
  // device is a connectivity failure, a request that ran out its deadline is a
  // slow response, and `unknown` keeps the retryable neutral copy.
  const errorVariant = selectInvoiceErrorVariant(query.error, committedConnectivity);
  // A thrown NOT_FOUND/FORBIDDEN/UNAUTHORIZED can't be fixed by retrying — show
  // a permanent state with no Retry. Those two variants are the only ones the
  // classifier takes from the thrown code, so they are the permanent set.
  const isPermanentError = errorVariant === 'not-found' || errorVariant === 'permission';

  // A later-page failure must keep the already-loaded rows and offer an inline
  // retry instead of replacing the list. Read `isFetchNextPageError`, not
  // `isError`: a failed background refetch of page 1 also raises `isError`,
  // and the inline Retry calls `fetchNextPage()`, which can never clear it.
  const isLaterPageError = query.isFetchNextPageError;

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <Animated.View exiting={FadeOut.duration(150)}>
        <InvoiceListSkeleton />
      </Animated.View>
    );
  } else if (isFirstPageError) {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <QueryError
          variant={errorVariant}
          onRetry={
            isPermanentError
              ? undefined
              : () => {
                  void query.refetch();
                }
          }
          isRetrying={query.isFetching}
        />
      </Animated.View>
    );
  } else if (entries.length === 0 && !hasMore && !isLaterPageError) {
    body = (
      <EmptyState
        icon={FileText}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
        refreshControl={refreshControl}
      />
    );
  } else {
    const footer = (
      // The paging block follows the rows: the last row draws no hairline, so
      // the footer owns the gap above it.
      <View className="pt-3">
        {hasMore && !isLaterPageError && (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="muted" className="text-center text-xs">
              {t('organization.invoices.truncated')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              onPress={() => {
                query.fetchNextPage();
              }}
              loading={query.isFetchingNextPage}
              accessibilityLabel={t('common.loadMore')}
            >
              <Text>{t('common.loadMore')}</Text>
            </Button>
          </View>
        )}
        {isLaterPageError && (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="muted" className="text-center text-xs">
              {t('common.couldnTLoadMore')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              className={STATE_ACTION_CLASS}
              onPress={() => {
                query.fetchNextPage();
              }}
              loading={query.isFetchingNextPage}
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        )}
        <View style={{ height: paddingBottom }} pointerEvents="none" />
      </View>
    );

    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlashList
          style={listStyle}
          data={entries}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          getItemType={() => 'invoice'}
          contentContainerStyle={listContentContainerStyle}
          refreshControl={refreshControl}
          ListEmptyComponent={
            <EmptyState
              placement="top"
              inset="gutter"
              icon={FileText}
              title={emptyTitle}
              description={emptyDescription}
              action={emptyAction}
            />
          }
          ListFooterComponent={footer}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={title}
        subtitle={subtitle}
        eyebrow={eyebrow}
        reserveEyebrow={reserveEyebrow}
        backFallback={backFallback}
      />
      {body}
    </View>
  );
}
