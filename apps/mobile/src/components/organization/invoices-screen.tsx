import { FileText } from 'lucide-react-native';
import { FlatList, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { EmptyState } from '@/components/empty-state';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type OrgInvoice, useOrgInvoices, useOrgRole } from '@/lib/hooks/use-organization-queries';
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
          ${(invoice.amount_due / 100).toFixed(2)}
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
  const { organizationId } = useOrgRole();
  const query = useOrgInvoices(organizationId);

  if (organizationId == null) {
    return null;
  }

  const isLoading = query.isLoading || !query.data;
  const invoices = query.data ?? [];

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Invoices" />
      {isLoading ? (
        <Animated.View exiting={FadeOut.duration(150)} className="gap-3 px-6 pt-4">
          <InvoiceRowSkeleton />
          <InvoiceRowSkeleton />
          <InvoiceRowSkeleton />
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(200)} className="flex-1">
          <FlatList
            data={invoices}
            keyExtractor={item => item.id}
            renderItem={({ item }) => <InvoiceRow invoice={item} />}
            contentContainerClassName="gap-3 px-6 pb-8 pt-4"
            ListEmptyComponent={
              <EmptyState
                icon={FileText}
                className="pt-16"
                title="No invoices"
                description="Invoices for this organization will show up here."
              />
            }
          />
        </Animated.View>
      )}
    </View>
  );
}
