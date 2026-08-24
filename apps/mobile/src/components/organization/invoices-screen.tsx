import { Download, FileText } from '@/components/ui/icons';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate, formatMoneyFromCents } from '@/lib/format';
import {
  type OrgInvoice,
  useOrgBoundary,
  useOrgInvoices,
} from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getInvoiceDownloadErrorMessage,
  selectInvoiceRowState,
  shareOrganizationInvoicePdf,
} from '@/lib/organization-invoice-download';
import { cn, firstNonEmpty } from '@/lib/utils';

const STATUS_META = {
  paid: {
    labelKey: 'organization.invoices.statusPaid',
    pillClass: 'bg-good',
    textClass: 'text-good-foreground',
  },
  open: {
    labelKey: 'organization.invoices.statusOpen',
    pillClass: 'bg-warn',
    textClass: 'text-warn-foreground',
  },
  void: {
    labelKey: 'organization.invoices.statusVoid',
    pillClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  },
} as const satisfies Record<string, { labelKey: string; pillClass: string; textClass: string }>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

function statusMeta(status: string) {
  const meta = lookup(STATUS_META, status);
  if (meta) {
    return { label: i18n.t(meta.labelKey), pillClass: meta.pillClass, textClass: meta.textClass };
  }
  return {
    label: status.charAt(0).toUpperCase() + status.slice(1),
    pillClass: 'bg-muted',
    textClass: 'text-muted-foreground',
  };
}

function InvoiceRowSkeleton() {
  return (
    <View className="gap-1.5 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-40 rounded" />
      <Skeleton className="h-3 w-24 rounded" />
    </View>
  );
}

function InvoiceRowContent({
  invoice,
  trailing,
}: Readonly<{
  invoice: OrgInvoice;
  trailing?: ReactNode;
}>) {
  const { t } = useTranslation();
  const meta = statusMeta(invoice.status);
  const title = firstNonEmpty(
    invoice.number,
    invoice.description,
    t('organization.invoices.invoiceFallback')
  );

  return (
    <>
      <View className="flex-row items-center justify-between gap-3">
        <View className="min-w-0 flex-1 flex-row items-center gap-2">
          {trailing}
          <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
            {title}
          </Text>
        </View>
        <Text className="text-sm font-medium text-foreground">
          {formatMoneyFromCents(invoice.amount_due, i18n.language)}
        </Text>
      </View>
      <View className="flex-row items-center justify-between">
        <Text className="text-xs text-muted-foreground">
          {formatDate(new Date(invoice.created * 1000), i18n.language)}
        </Text>
        <View className={cn('rounded-full px-2 py-0.5', meta.pillClass)}>
          <Text className={cn('text-[11px] font-medium', meta.textClass)}>{meta.label}</Text>
        </View>
      </View>
    </>
  );
}

function InvoiceRow({ invoice }: Readonly<{ invoice: OrgInvoice }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [sharing, setSharing] = useState(false);
  const rowState = selectInvoiceRowState({
    invoicePdf: invoice.invoice_pdf,
    sharing,
  });

  if (rowState === 'no-affordance') {
    return (
      <View className="gap-1 rounded-lg bg-secondary p-3">
        <InvoiceRowContent invoice={invoice} />
      </View>
    );
  }

  async function handleDownload() {
    if (invoice.invoice_pdf === null) {
      return;
    }
    setSharing(true);
    try {
      await shareOrganizationInvoicePdf({
        id: invoice.id,
        number: invoice.number,
        description: invoice.description,
        invoice_pdf: invoice.invoice_pdf,
      });
    } catch (error) {
      toast.error(getInvoiceDownloadErrorMessage(error));
    } finally {
      setSharing(false);
    }
  }

  const busy = rowState === 'busy';

  return (
    <Pressable
      onPress={() => {
        void handleDownload();
      }}
      disabled={busy}
      accessibilityState={{ busy }}
      accessibilityRole="button"
      accessibilityLabel={t('organization.invoices.downloadA11y', {
        number: firstNonEmpty(invoice.number, invoice.description, invoice.id),
      })}
      className="gap-1 rounded-lg bg-secondary p-3 active:opacity-80 disabled:opacity-60"
    >
      <InvoiceRowContent
        invoice={invoice}
        trailing={
          busy ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Download size={14} color={colors.mutedForeground} />
          )
        }
      />
    </Pressable>
  );
}

export function OrganizationInvoicesScreen() {
  const { t } = useTranslation();
  const { organizationId, org, isResolving } = useOrgBoundary();
  const query = useOrgInvoices(organizationId);
  const paddingBottom = useTabBarBottomPadding();

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.invoices.title')} />;
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
      <Animated.View entering={FadeIn.duration(200)} className="flex-1" style={{ paddingBottom }}>
        <QueryError onRetry={() => void query.refetch()} isRetrying={query.isFetching} />
      </Animated.View>
    );
  } else {
    body = (
      <Animated.View entering={FadeIn.duration(200)} className="flex-1">
        <FlatList
          data={invoices}
          keyExtractor={item => item.id}
          renderItem={({ item }) => <InvoiceRow invoice={item} />}
          contentContainerClassName="grow gap-3 px-6 pt-4"
          ListEmptyComponent={
            <EmptyState
              icon={FileText}
              title={t('organization.invoices.emptyTitle')}
              description={t('organization.invoices.emptyDescription')}
            />
          }
          ListFooterComponent={<View style={{ height: paddingBottom }} pointerEvents="none" />}
        />
      </Animated.View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.invoices.title')} />
      {body}
    </View>
  );
}
