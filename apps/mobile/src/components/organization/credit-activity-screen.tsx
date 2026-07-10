import { Receipt } from 'lucide-react-native';
import { FlatList, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type CreditTransaction,
  useOrgCreditTransactions,
  useOrgRole,
} from '@/lib/hooks/use-organization-queries';
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
  const amount = transaction.amount_microdollars / 1_000_000;
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
          {isPositive ? '+' : '-'}${Math.abs(amount).toFixed(2)}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">
          {parseTimestamp(transaction.created_at).toLocaleDateString()}
        </Text>
        {transaction.expiry_date != null && (
          <Text className="text-xs text-muted-foreground">
            Expires {parseTimestamp(transaction.expiry_date).toLocaleDateString()}
          </Text>
        )}
      </View>
    </View>
  );
}

export function OrganizationCreditActivityScreen() {
  const { organizationId } = useOrgRole();
  const query = useOrgCreditTransactions(organizationId);

  if (organizationId == null) {
    return null;
  }

  const isLoading = query.isLoading || !query.data;
  const transactions = query.data ?? [];

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Credit activity" />
      {isLoading ? (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
          <CreditRowSkeleton />
          <CreditRowSkeleton />
          <CreditRowSkeleton />
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <FlatList
            data={transactions}
            keyExtractor={item => item.id}
            renderItem={({ item }) => <CreditRow transaction={item} />}
            contentContainerClassName="gap-3 px-6 pb-8 pt-4"
            ListEmptyComponent={
              <EmptyState
                icon={Receipt}
                className="pt-16"
                title="No credit activity"
                description="Credit transactions for this organization will show up here."
              />
            }
          />
        </Animated.View>
      )}
    </View>
  );
}
