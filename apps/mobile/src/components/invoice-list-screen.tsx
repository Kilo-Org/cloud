import { FileText } from '@/components/ui/icons';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
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
  readonly refetch: () => void;
  readonly fetchNextPage: () => void;
};

// FlashList takes `contentContainerStyle` (no className), so the FlatList's
// `grow gap-3 px-6 pt-4` content classes map to their pixel values. FlashList v2
// positions every cell absolutely and has no `gap` handling (2.3.2 ships zero
// `gap` references), so the 12px inter-row gap rides on the measured item
// separator instead of `contentContainerStyle.gap`. The old container `gap` also
// sat between the last row and the pagination footer; FlashList's separator only
// spans items, so that boundary carries the same 12px as `pt-3` on the footer.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = {
  flexGrow: 1,
  paddingHorizontal: 24,
  paddingTop: 16,
} satisfies ViewStyle;

const InvoiceRowSeparator = () => <View className="h-3" />;

function InvoiceRowSkeleton() {
  return (
    <View className="gap-1.5 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="h-3 w-24 rounded" />
    </View>
  );
}

type InvoiceListScreenProps = Readonly<{
  /** The screen's own title: the personal and organization lists differ. */
  title: string;
  /** The scope's paged invoice read, flattened by its own hook. */
  query: InvoiceListQuery;
  entries: readonly Invoice[];
  hasMore: boolean;
  emptyTitle: string;
  emptyDescription: string;
}>;

/**
 * The invoice list both scopes render: a person's own invoices and an
 * organization's are the same Stripe shape, so the rows, the paging footer and
 * every state live here once. A scope supplies its read and its empty copy.
 */
export function InvoiceListScreen({
  title,
  query,
  entries,
  hasMore,
  emptyTitle,
  emptyDescription,
}: InvoiceListScreenProps) {
  const { t } = useTranslation();
  const paddingBottom = useTabBarBottomPadding();
  const committedConnectivity = useCommittedConnectivityStatus();

  // `InvoiceRow` is memoized at module scope, so the renderer keeps one identity
  // across data updates and only the changed rows re-render.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Invoice>) => <InvoiceRow invoice={item} />,
    []
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
      <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
        <InvoiceRowSkeleton />
        <InvoiceRowSkeleton />
        <InvoiceRowSkeleton />
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
                  query.refetch();
                }
          }
          isRetrying={query.isFetching}
        />
      </Animated.View>
    );
  } else if (entries.length === 0 && !hasMore && !isLaterPageError) {
    body = <EmptyState icon={FileText} title={emptyTitle} description={emptyDescription} />;
  } else {
    const footer = (
      // The former container gap also separated the last row from this footer
      // block, which the item separator does not cover.
      <View className="pt-3">
        {hasMore && !isLaterPageError && (
          <View className="items-center gap-3 px-6 py-4">
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
          <View className="items-center gap-3 px-6 py-4">
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
          ItemSeparatorComponent={InvoiceRowSeparator}
          contentContainerStyle={listContentContainerStyle}
          ListEmptyComponent={
            <EmptyState
              placement="top"
              icon={FileText}
              title={emptyTitle}
              description={emptyDescription}
            />
          }
          ListFooterComponent={footer}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={title} />
      {body}
    </View>
  );
}
