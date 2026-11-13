import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { ExternalLink } from '@/components/ui/icons';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import {
  type CreditDeduction,
  type CreditGrantKind,
  creditGrantKind,
  creditPurchaseChannel,
  type CreditPurchaseEntry,
} from '@/lib/credits/credit-history';
import { keepZoneWithDate } from '@/lib/credits/expiry-zone';
import { formatDate, formatPrefixedMoney } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { firstNonEmpty, parseTimestamp } from '@/lib/utils';

const DEDUCTION_LABEL_KEYS = {
  deduction: 'credits.history.kind.deduction',
  adjustment: 'credits.history.kind.adjustment',
  balance_neutral: 'credits.history.kind.balanceNeutral',
} satisfies Record<string, string>;

/** The row title a purchase kind renders, in the reader's language. */
const PURCHASE_TITLE_KEYS = {
  purchase: 'credits.history.purchaseFallback',
  auto_top_up: 'organization.billing.autoTopUp',
} satisfies Record<CreditPurchaseEntry['kind'], string>;

/** The note a store-sold pack carries instead of a receipt action. */
const STORE_RECEIPT_KEYS = {
  app_store: 'credits.history.appStoreReceipt',
  google_play: 'credits.history.googlePlayReceipt',
} satisfies Record<string, string>;

/** Looks up a possibly-unknown key in a literal dictionary without widening its type. */
function lookup<V>(dictionary: Readonly<Record<string, V>>, key: string): V | undefined {
  return (dictionary as Readonly<Record<string, V | undefined>>)[key];
}

function deductionTypeLabel(kind: CreditDeduction['kind']): string {
  const key = lookup(DEDUCTION_LABEL_KEYS, kind);
  return key ? i18n.t(key) : kind;
}

/**
 * The grant line's type, following the web credits page: the recorded channel
 * decides, and only a grant with none falls back to its free flag.
 */
const GRANT_LABEL_KEYS = {
  purchase: 'credits.history.kind.purchase',
  pass: 'kiloPass.title',
  grant: 'credits.history.kind.grant',
} satisfies Record<CreditGrantKind, string>;

function grantTypeLabel(grant: { credit_source: string | null; is_free: boolean }): string {
  return i18n.t(
    GRANT_LABEL_KEYS[creditGrantKind({ creditSource: grant.credit_source, isFree: grant.is_free })]
  );
}

/** A signed credit amount, kept in its own left-to-right run. */
function creditAmountLabel(amountMicrodollars: number): string {
  const isPositive = amountMicrodollars >= 0;
  return isolateLtrBidiText(
    `${isPositive ? '+' : '-'}${formatPrefixedMoney(
      Math.abs(fromMicrodollars(amountMicrodollars)),
      i18n.language
    )}`
  );
}

type PurchaseHistoryRowProps = Readonly<{
  entry: CreditPurchaseEntry;
  isOpeningReceipt: boolean;
  onOpenReceipt: (transactionId: string) => void;
}>;

/**
 * The receipt action's reach. Its own box is the audit's 28 dp floor and
 * renders 27.8 dp at this density, so the slop has to carry it past
 * `DESIGN.md`'s 44 dp: 8 per side lands on 43.8 dp, and 9 measures 45.8 dp.
 * Horizontal too: the row's `gap-3` keeps the reach off the amount beside it.
 */
const RECEIPT_HIT_SLOP = { top: 9, bottom: 9, left: 9, right: 9 } as const;

/**
 * One paid credit purchase.
 *
 * A card purchase keeps its Stripe receipt behind the trailing action; a pack
 * the App Store or Play sold has no Stripe invoice, so its row names the store
 * that holds the receipt instead.
 */
export const PurchaseHistoryRow = memo(function PurchaseHistoryRow({
  entry,
  isOpeningReceipt,
  onOpenReceipt,
}: PurchaseHistoryRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const channel = creditPurchaseChannel(entry.creditSource);
  // A kind this app predates still paints a title: the purchase label is the
  // generic row name, and an empty one reads as a broken row.
  const title = t(lookup(PURCHASE_TITLE_KEYS, entry.kind) ?? 'credits.history.purchaseFallback');

  const storeReceiptKey = lookup(STORE_RECEIPT_KEYS, channel);
  const storeReceiptNote = storeReceiptKey ? t(storeReceiptKey) : null;
  const expiryLabel = entry.expiryDate
    ? keepZoneWithDate(
        t('organization.creditActivity.expiresUtc', {
          date: formatDate(parseTimestamp(entry.expiryDate), i18n.language, { timeZone: 'UTC' }),
        })
      )
    : null;

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm font-medium text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-sm font-medium text-good">
          {creditAmountLabel(entry.amount_mUsd)}
        </Text>
        {channel === 'card' && (
          <Pressable
            // The audit reads the pressable's own rect, and the glyph is 14 dp,
            // so the box carries the floor itself: 28 dp, with the negative
            // margin cancelling it back to one line so the row keeps its
            // height (the same form as `INLINE_LINK_BOX_CLASS`). The slop then
            // carries the reach to 44 dp without overlapping the amount beside
            // it.
            className="-my-[7px] min-h-[28px] min-w-[28px] items-center justify-center active:opacity-70"
            hitSlop={RECEIPT_HIT_SLOP}
            disabled={isOpeningReceipt}
            accessibilityRole="button"
            accessibilityState={{ busy: isOpeningReceipt }}
            accessibilityLabel={t('credits.history.receiptA11y', { description: title })}
            onPress={() => {
              onOpenReceipt(entry.id);
            }}
          >
            {isOpeningReceipt ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <ExternalLink size={14} color={colors.mutedForeground} />
            )}
          </Pressable>
        )}
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Text className="text-xs text-muted-foreground">
          {formatDate(parseTimestamp(entry.date), i18n.language)}
        </Text>
        {/* Both lines, not either: a pack Play sold still expires a year after
            purchase, so its row keeps the expiry beside the store that holds
            the receipt. */}
        {expiryLabel != null && (
          <Text className="text-xs text-muted-foreground">{expiryLabel}</Text>
        )}
        {storeReceiptNote != null && (
          <Text className="text-xs text-muted-foreground">{storeReceiptNote}</Text>
        )}
      </View>
    </View>
  );
});

function LedgerLine({
  title,
  typeLabel,
  amountMicrodollars,
  date,
  muted,
}: Readonly<{
  title: string;
  typeLabel: string;
  amountMicrodollars: number;
  date: string | null;
  muted?: boolean;
}>) {
  return (
    <View className={muted ? 'gap-1 pl-4' : 'gap-1'}>
      <View className="flex-row items-center justify-between gap-3">
        <Text
          className={
            muted
              ? 'min-w-0 flex-1 text-sm text-muted-foreground'
              : 'min-w-0 flex-1 text-sm font-medium text-foreground'
          }
          numberOfLines={1}
        >
          {title}
        </Text>
        <Text className={amountMicrodollars >= 0 ? 'text-sm text-good' : 'text-sm text-foreground'}>
          {creditAmountLabel(amountMicrodollars)}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {date != null && (
          <Text className="text-xs text-muted-foreground">
            {formatDate(parseTimestamp(date), i18n.language)}
          </Text>
        )}
        <Text className="text-xs text-muted-foreground">{typeLabel}</Text>
      </View>
    </View>
  );
}

/**
 * One ledger event: a grant (a purchase, a bonus, a Kilo Pass month), a
 * deduction, an adjustment, or a balance-neutral settlement. A grant whose
 * expiry closed it reads as one event, with the expiry as its second line —
 * unless the grant already has its own purchase row above, in which case this
 * row reads as the expiry alone.
 */
export const LedgerHistoryRow = memo(function LedgerHistoryRow({
  deduction,
  grantListed,
}: Readonly<{ deduction: CreditDeduction; grantListed: boolean }>) {
  const { t } = useTranslation();
  // The purchase row carries the grant, its receipt, and its expiry date, so a
  // grant printed again here would read as a second purchase.
  const purchase = grantListed ? null : deduction.purchase;

  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <LedgerLine
        title={firstNonEmpty(
          purchase?.description,
          deduction.description,
          t('credits.history.deductionFallback')
        )}
        typeLabel={purchase ? grantTypeLabel(purchase) : deductionTypeLabel(deduction.kind)}
        amountMicrodollars={purchase ? purchase.amount_mUsd : deduction.amount_mUsd}
        date={purchase?.date ?? deduction.date}
      />
      {purchase != null && (
        <LedgerLine
          title={firstNonEmpty(deduction.description, deductionTypeLabel(deduction.kind))}
          typeLabel={deductionTypeLabel(deduction.kind)}
          amountMicrodollars={deduction.amount_mUsd}
          date={null}
          muted
        />
      )}
    </View>
  );
});
