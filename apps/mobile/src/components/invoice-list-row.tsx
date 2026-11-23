import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { Download } from '@/components/ui/icons';
import { type TFunction } from 'i18next';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import { formatDate, formatPrefixedMoney } from '@/lib/format';
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

function statusMeta(status: string, t: TFunction) {
  const meta = lookup(STATUS_META, status);
  const labelKey = lookup(STATUS_LABEL_KEYS, status);
  return {
    label: labelKey ? t(labelKey) : status,
    pillClass: meta?.pillClass ?? NEUTRAL_BADGE.pillClass,
    textClass: meta?.textClass ?? NEUTRAL_BADGE.textClass,
  };
}

/** The row's facts, in the reader's language. One source for paint and name. */
type InvoiceRowFacts = Readonly<{
  title: string;
  /** The painted amount, kept in its own left-to-right run. */
  amount: string;
  date: string;
  status: string;
  pillClass: string;
  textClass: string;
}>;

/**
 * Every fact the row paints, formatted once. The paint and the row's accessible
 * name both read this, so an amount the screen shows and the amount a screen
 * reader hears cannot drift apart.
 */
function invoiceRowFacts(invoice: Invoice, t: TFunction): InvoiceRowFacts {
  const meta = statusMeta(invoice.status, t);
  return {
    title: firstNonEmpty(
      invoice.number,
      invoice.description,
      t('organization.invoices.invoiceFallback')
    ),
    amount: isolateLtrBidiText(formatPrefixedMoney(invoice.amount_due / 100, i18n.language)),
    date: formatDate(new Date(invoice.created * 1000), i18n.language),
    status: meta.label,
    pillClass: meta.pillClass,
    textClass: meta.textClass,
  };
}

/**
 * Every row reserves the action's box on the trailing edge, so the download
 * glyph never shifts an invoice number and a row without a PDF still lines its
 * amount up with the rows that carry the action. 20 dp is the spinner's box.
 */
function InvoiceRowContent({
  facts,
  action,
}: Readonly<{
  facts: InvoiceRowFacts;
  action?: ReactNode;
}>) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center justify-between gap-3">
          <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
            {facts.title}
          </Text>
          <Text className="text-sm font-medium text-foreground">{facts.amount}</Text>
        </View>
        <View className="flex-row items-center justify-between">
          <Text className="text-xs text-muted-foreground">{facts.date}</Text>
          <View className={cn('rounded-full px-2 py-0.5', facts.pillClass)}>
            <Text className={cn('text-xs font-medium', facts.textClass)}>{facts.status}</Text>
          </View>
        </View>
      </View>
      <View className="w-5 items-center justify-center">{action}</View>
    </View>
  );
}

export const InvoiceRow = memo(function InvoiceRow({
  invoice,
  last = false,
}: Readonly<{ invoice: Invoice; last?: boolean }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const facts = invoiceRowFacts(invoice, t);
  const [sharing, setSharing] = useState(false);
  const rowState = selectInvoiceRowState({
    invoicePdf: invoice.invoice_pdf,
    sharing,
  });

  // A flat list row: full-bleed, content from the page gutter, one hairline
  // between rows and none after the last.
  const rowClassName = cn(
    ROW_TARGET_CLASS,
    'flex-row items-center gap-3 px-4 py-3',
    !last && 'border-b-[0.5px] border-hair-soft'
  );

  if (rowState === 'no-affordance') {
    return (
      <View className={rowClassName}>
        <InvoiceRowContent facts={facts} />
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
      // The whole row is one button, so its name has to carry what a reader
      // needs to pick this receipt out of the list: which invoice, its amount,
      // its date and its status — the shape the credit-history receipt row
      // uses. The action verb leads, because Android carries no spoken hint.
      accessibilityLabel={t('organization.invoices.downloadA11y', {
        number: facts.title,
        amount: facts.amount,
        date: facts.date,
        status: facts.status,
      })}
      className={cn(rowClassName, 'active:opacity-70')}
    >
      <InvoiceRowContent
        facts={facts}
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
