import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useLocalSearchParams } from 'expo-router';
import { Receipt } from '@/components/ui/icons';
import { type ReactNode, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate, formatMoney } from '@/lib/format';
import {
  type CreditTransaction,
  useOrgBoundary,
  useOrgCreditTransactionsPage,
} from '@/lib/hooks/use-organization-queries';
import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';
import { useOrganization } from '@/lib/organization-context';
import { reconcileOrgDeepLink } from '@/lib/org-deep-link';
import { cn, firstNonEmpty, parseTimestamp } from '@/lib/utils';

function humanizeCategory(category: string): string {
  const spaced = category.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function CreditRowSkeleton() {
  return (
    <View className="gap-1.5 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="h-3 w-24 rounded" />
    </View>
  );
}

function CreditRow({ transaction }: Readonly<{ transaction: CreditTransaction }>) {
  const { t } = useTranslation();
  const amount = fromMicrodollars(transaction.amount_microdollars);
  const isPositive = amount >= 0;
  const title = firstNonEmpty(
    transaction.description,
    transaction.credit_category ? humanizeCategory(transaction.credit_category) : undefined,
    t('organization.creditActivity.transactionFallback')
  );

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className={cn('text-sm font-medium', isPositive ? 'text-good' : 'text-foreground')}>
          {isPositive ? '+' : '-'}
          {formatMoney(Math.abs(amount), i18n.language)}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">
          {formatDate(parseTimestamp(transaction.created_at), i18n.language)}
        </Text>
        {transaction.expiry_date != null && (
          <Text className="text-xs text-muted-foreground">
            {t('organization.creditActivity.expires', {
              date: formatDate(parseTimestamp(transaction.expiry_date), i18n.language),
            })}
          </Text>
        )}
      </View>
    </View>
  );
}

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  if (!Array.isArray(value) && value !== undefined && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value[0] !== undefined && value[0].length > 0) {
    return value[0];
  }
  return undefined;
}

export function OrganizationCreditActivityScreen() {
  const { t } = useTranslation();
  const { org: orgParamRaw } = useLocalSearchParams<{ org?: string | string[] }>();
  const orgParam = firstSearchParam(orgParamRaw);

  const { organizationId: contextOrganizationId, isLoaded, setOrganizationId } = useOrganization();
  // When `org` is present, resolve role/membership against the param only — never
  // the pre-tap context selection — so wrong-org data cannot render.
  const { org, orgs, isLoading: orgsLoading, isResolving, isError } = useOrgBoundary(orgParam);

  // While the list is loading, pass `undefined` so reconcile marks `isResolving`.
  // Once settled (success or error), pass the array (or empty) so a foreign param
  // cannot fall through to the context org's transactions.
  const reconcile = reconcileOrgDeepLink({
    orgParam,
    contextOrganizationId,
    orgs: orgsLoading ? undefined : (orgs ?? []),
  });

  useEffect(() => {
    // Wait for SecureStore hydration so the deep-link selection always wins over stored org.
    if (isLoaded && reconcile.shouldPersistOverride && reconcile.effectiveOrganizationId != null) {
      setOrganizationId(reconcile.effectiveOrganizationId);
    }
  }, [
    isLoaded,
    reconcile.shouldPersistOverride,
    reconcile.effectiveOrganizationId,
    setOrganizationId,
  ]);

  // Key transactions only on the reconcile query id — never the pre-tap context
  // org while a deep-link param is present and unvalidated/invalid.
  const {
    query,
    entries: transactions,
    hasMore,
  } = useOrgCreditTransactionsPage(reconcile.queryOrganizationId);
  const paddingBottom = useTabBarBottomPadding();
  useRouteForegroundRefresh([[['organizations']]]);

  const showBoundary =
    isResolving ||
    reconcile.isResolving ||
    isError ||
    reconcile.queryOrganizationId == null ||
    org == null;

  if (showBoundary) {
    return (
      <OrganizationBoundary
        title={t('organization.creditActivity.title')}
        organizationIdOverride={orgParam}
      />
    );
  }

  const isLoading = query.isPending;
  const hasLoadedPages = (query.data?.pages.length ?? 0) > 0;
  const isFirstPageError = query.isError && !hasLoadedPages;

  // A thrown NOT_FOUND/FORBIDDEN/UNAUTHORIZED can't be fixed by retrying — show
  // a permanent state with no Retry. Any other first-page error stays retryable.
  const errorCode = query.error?.data?.code;
  const isPermanentError =
    errorCode === 'NOT_FOUND' || errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED';

  // NOT_FOUND maps to the not-found state; FORBIDDEN/UNAUTHORIZED map to the
  // permission state. Any other error stays the retryable neutral state.
  let errorVariant: 'neutral' | 'server' | 'not-found' | 'permission' = 'neutral';
  if (errorCode === 'NOT_FOUND') {
    errorVariant = 'not-found';
  } else if (errorCode === 'FORBIDDEN' || errorCode === 'UNAUTHORIZED') {
    errorVariant = 'permission';
  }

  // A later-page failure must keep the already-loaded rows and offer an inline
  // retry instead of replacing the list.
  const isLaterPageError = query.isError && hasLoadedPages;

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
        <CreditRowSkeleton />
        <CreditRowSkeleton />
        <CreditRowSkeleton />
      </Animated.View>
    );
  } else if (isFirstPageError) {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1" style={{ paddingBottom }}>
        <QueryError
          variant={errorVariant}
          onRetry={isPermanentError ? undefined : () => void query.refetch()}
          isRetrying={query.isFetching}
        />
      </Animated.View>
    );
  } else {
    const footer = (
      <View>
        {hasMore && !isLaterPageError && (
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
              {t('organization.creditActivity.truncated')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void query.fetchNextPage()}
              loading={query.isFetchingNextPage}
              accessibilityLabel={t('organization.creditActivity.loadMore')}
            >
              <Text>{t('organization.creditActivity.loadMore')}</Text>
            </Button>
          </View>
        )}
        {isLaterPageError && (
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
              {t('organization.creditActivity.loadMoreFailed')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void query.fetchNextPage()}
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
        <FlatList
          data={transactions}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <CreditRow transaction={item} />}
          contentContainerClassName="grow gap-3 px-6 pt-4"
          ListEmptyComponent={
            <EmptyState
              icon={Receipt}
              title={t('organization.creditActivity.emptyTitle')}
              description={t('organization.creditActivity.emptyDescription')}
            />
          }
          ListFooterComponent={footer}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.creditActivity.title')} />
      {body}
    </View>
  );
}
