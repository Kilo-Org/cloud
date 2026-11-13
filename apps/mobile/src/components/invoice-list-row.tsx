import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { Download } from '@/components/ui/icons';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { formatDate, formatMoneyFromCents } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getInvoiceDownloadErrorMessage,
  selectInvoiceRowState,
  shareInvoicePdf,
} from '@/lib/invoice-download';
import { cn, firstNonEmpty } from '@/lib/utils';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** One Stripe invoice, in the shape both invoice scopes return. */
export type Invoice = RouterOutputs['user']['invoicesPage']['entries'][number];

const STATUS_LABEL_KEYS = {
  paid: 'organization.invoices.status.paid',
  open: 'organization.invoices.status.open',
  void: 'organization.invoices.status.void',
  draft: 'common.draft',
  uncollectible: 'organization.invoices.status.uncollectible',
  unknown: 'common.unknown',
} satisfies Record<string, string>;

/**
 * The badge every status without a hue of its own wears: the gray the model
 * badges use, which differs from the row's `bg-secondary` in both themes (the
 * theme's `--muted` equals `--secondary`, so a `bg-muted` pill has no band on
 * this row). `text-ink2` stays readable on it; the muted foreground does not.
 */
const NEUTRAL_BADGE = {
  pillClass: 'bg-neutral-200 dark:bg-neutral-700',
  textClass: 'text-ink2',
} as const;

const STATUS_META = {
  paid: {
    pillClass: 'bg-good',
    textClass: 'text-good-foreground',
  },
  open: {
    pillClass: 'bg-warn',
    textClass: 'text-warn-foreground',
  },
  void: NEUTRAL_BADGE,
} as const satisfies Record<string, { pillClass: string; textClass: string }>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

function statusMeta(status: string) {
  const meta = lookup(STATUS_META, status);
  const labelKey = lookup(STATUS_LABEL_KEYS, status);
  return {
    label: labelKey ? i18n.t(labelKey) : status,
    pillClass: meta?.pillClass ?? NEUTRAL_BADGE.pillClass,
    textClass: meta?.textClass ?? NEUTRAL_BADGE.textClass,
  };
}

/**
 * Every row reserves the action's box on the trailing edge, so the download
 * glyph never shifts an invoice number and a row without a PDF still lines its
 * amount up with the rows that carry the action. 20 dp is the spinner's box.
 */
function InvoiceRowContent({
  invoice,
  action,
}: Readonly<{
  invoice: Invoice;
  action?: ReactNode;
}>) {
  const { t } = useTranslation();
  const meta = statusMeta(invoice.status);
  const title = firstNonEmpty(
    invoice.number,
    invoice.description,
    t('organization.invoices.invoiceFallback')
  );

  return (
    <View className="flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
            {title}
          </Text>
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
      </View>
      <View className="w-5 items-center justify-center">{action}</View>
    </View>
  );
}

export const InvoiceRow = memo(function InvoiceRow({ invoice }: Readonly<{ invoice: Invoice }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [sharing, setSharing] = useState(false);
  const rowState = selectInvoiceRowState({
    invoicePdf: invoice.invoice_pdf,
    sharing,
  });

  if (rowState === 'no-affordance') {
    return (
      <View className="rounded-lg bg-secondary p-3">
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
      await shareInvoicePdf({
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
      className="rounded-lg bg-secondary p-3 active:opacity-80 disabled:opacity-60"
    >
      <InvoiceRowContent
        invoice={invoice}
        action={
          busy ? (
            <ActivityIndicator size="small" color={colors.mutedForeground} />
          ) : (
            <Download size={14} color={colors.mutedForeground} />
          )
        }
      />
    </Pressable>
  );
});
