import { formatCents } from '@kilocode/app-shared/utils';
import { FileText } from 'lucide-react-native';
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
  type OrgInvoice,
  useOrgBoundary,
  useOrgInvoices,
} from '@/lib/hooks/use-organization-queries';
import { cn, firstNonEmpty } from '@/lib/utils';

const STATUS_META: Record<string, { label: string; pillClass: string; textClass: string }> = {
  paid: { label: 'Paid', pillClass: 'bg-good', textClass: 'text-good-foreground' },
  open: { label: 'Open', pillClass: 'bg-warn', textClass: 'text-warn-foreground' },
  void: { label: 'Void', pillClass: 'bg-muted', textClass: 'text-muted-foreground' },
};

function statusMeta(status: string): { label: string; pillClass: string; textClass: string } {
  return (
    STATUS_META[status] ?? {
      label: status.charAt(0).toUpperCase() + status.slice(1),
      pillClass: 'bg-muted',
      textClass: 'text-muted-foreground',
    }
  );
}

function InvoiceRowSkeleton() {
  return (
    <View className="gap-1.5 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="h-3 w-24 rounded" />
    </View>
  );
}

function InvoiceRow({ invoice }: Readonly<{ invoice: OrgInvoice }>) {
  const meta = statusMeta(invoice.status);
  const title = firstNonEmpty(invoice.number, invoice.description, 'Invoice');

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-sm font-medium text-foreground">
          {formatCents(invoice.amount_due)}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">
          {new Date(invoice.created * 1000).toLocaleDateString()}
        </Text>
        <View className={cn('rounded-full px-2 py-0.5', meta.pillClass)}>
          <Text className={cn('text-[11px] font-medium', meta.textClass)}>{meta.label}</Text>
        </View>
      </View>
    </View>
  );
}

export function OrganizationInvoicesScreen() {
  const { organizationId, org, isResolving } = useOrgBoundary();
  const query = useOrgInvoices(organizationId);
  const paddingBottom = useTabBarBottomPadding();

  if (isResolving || organizationId == null || org == null) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Invoices" />
        <OrganizationBoundary isResolving={isResolving} />
      </View>
    );
  }

  const isLoading = query.isLoading;
  const isError = query.isError && !query.data;
  const invoices = query.data ?? [];

  let body: ReactNode = null;
  if (isLoading) {
    body = (
      <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
        <InvoiceRowSkeleton />
        <InvoiceRowSkeleton />
        <InvoiceRowSkeleton />
      </Animated.View>
    );
  } else if (isError) {
    body = (
      <QueryError
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
        placement="top"
      />
    );
  } else {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlatList
          data={invoices}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <InvoiceRow invoice={item} />}
          contentContainerClassName="gap-3 px-6 pt-4"
          contentContainerStyle={{ paddingBottom }}
          ListEmptyComponent={
            <EmptyState
              icon={FileText}
              className="pt-16"
              title="No invoices"
              description="Invoices are generated automatically each billing cycle and will appear here once your organization is billed."
            />
          }
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Invoices" />
      {body}
    </View>
  );
}
