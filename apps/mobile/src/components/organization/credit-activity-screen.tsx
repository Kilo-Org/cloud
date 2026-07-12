import { formatDollars, fromMicrodollars } from '@kilocode/app-shared/utils';
import { Receipt } from 'lucide-react-native';
import { type ReactNode } from 'react';
import { FlatList, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type CreditTransaction,
  useOrgBoundary,
  useOrgCreditTransactions,
} from '@/lib/hooks/use-organization-queries';
import { cn, firstNonEmpty, formatDate, parseTimestamp } from '@/lib/utils';

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
  const amount = fromMicrodollars(transaction.amount_microdollars);
  const isPositive = amount >= 0;
  const title = firstNonEmpty(
    transaction.description,
    transaction.credit_category ? humanizeCategory(transaction.credit_category) : undefined,
    'Credit transaction'
  );

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className={cn('text-sm font-medium', isPositive ? 'text-good' : 'text-foreground')}>
          {isPositive ? '+' : '-'}
          {formatDollars(Math.abs(amount))}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">
          {formatDate(parseTimestamp(transaction.created_at))}
        </Text>
        {transaction.expiry_date != null && (
          <Text className="text-xs text-muted-foreground">
            Expires {formatDate(parseTimestamp(transaction.expiry_date))}
          </Text>
        )}
      </View>
    </View>
  );
}

export function OrganizationCreditActivityScreen() {
  const { organizationId, org, isResolving } = useOrgBoundary();
  const query = useOrgCreditTransactions(organizationId);
  const paddingBottom = useTabBarBottomPadding();

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title="Credit activity" />;
  }

  const isLoading = query.isLoading;
  const isError = query.isError && !query.data;
  const transactions = query.data ?? [];

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
        <CreditRowSkeleton />
        <CreditRowSkeleton />
        <CreditRowSkeleton />
      </Animated.View>
    );
  } else if (isError) {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1" style={{ paddingBottom }}>
        <QueryError onRetry={() => void query.refetch()} isRetrying={query.isFetching} />
      </Animated.View>
    );
  } else {
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
              title="No credit activity"
              description="Purchases, usage, and credit adjustments for this organization will appear here as they happen."
            />
          }
          ListFooterComponent={<View style={{ height: paddingBottom }} pointerEvents="none" />}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Credit activity" />
      {body}
    </View>
  );
}
