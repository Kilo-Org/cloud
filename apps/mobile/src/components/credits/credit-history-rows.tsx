import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { ExternalLink } from '@/components/ui/icons';
import { type TFunction } from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { INLINE_LINK_BOX_CLASS } from '@/lib/a11y/tap-target';
import { isolateLtrBidiText } from '@/lib/bidi';
import {
  type CreditDeduction,
  type CreditGrant,
  type CreditGrantKind,
  creditGrantKind,
  type CreditGrantReason,
  creditPurchaseChannel,
  type CreditPurchaseEntry,
} from '@/lib/credits/credit-history';
import { keepZoneWithDate } from '@/lib/credits/expiry-zone';
import { formatDate, formatPrefixedMoney } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn, firstNonEmpty, parseTimestamp } from '@/lib/utils';

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

function deductionTypeLabel(t: TFunction, kind: CreditDeduction['kind']): string {
  const key = lookup(DEDUCTION_LABEL_KEYS, kind);
  return key ? t(key) : kind;
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

function grantTypeLabel(
  t: TFunction,
  grant: { credit_source: string | null; is_free: boolean }
): string {
  return t(
    GRANT_LABEL_KEYS[creditGrantKind({ creditSource: grant.credit_source, isFree: grant.is_free })]
  );
}

/** The row title a positive grant renders, in the reader's language. */
const GRANT_TITLE_KEYS = {
  referral: 'kiloPass.bonusReferral',
  welcome: 'credits.history.kind.welcomeCredits',
  kilo_pass: 'kiloPass.title',
  promotional: 'credits.history.kind.promotionalCredits',
  influencer: 'credits.history.program.influencer',
  usage_issue: 'credits.history.program.usageIssue',
  pull_request: 'credits.history.program.pullRequest',
  vibe_day: 'credits.history.program.vibeDay',
  feedback: 'credits.history.program.feedback',
  admin_bulk_grant: 'credits.history.program.adminBulkGrant',
  oss_sponsorship: 'credits.history.program.ossSponsorship',
  oss_monthly_reset: 'credits.history.program.ossMonthlyReset',
  contributor_champion: 'credits.history.program.contributorChampion',
  adjustment: 'credits.history.kind.adjustment',
} satisfies Record<CreditGrantReason, string>;

/**
 * The row title a grant reason renders, in the reader's language. The catalog
 * is read through the row's own translator, so React Compiler cannot cache one
 * language's title across an in-place language switch.
 */
function grantTitle(t: TFunction, reason: CreditGrantReason): string {
  return t(lookup(GRANT_TITLE_KEYS, reason) ?? 'credits.history.kind.grant');
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
  /** The final row of the list draws no divider under it. */
  last: boolean;
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
  last,
}: PurchaseHistoryRowProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const channel = creditPurchaseChannel(entry.creditSource);
  // A kind this app predates still paints a title: the purchase label is the
  // generic row name, and an empty one reads as a broken row.
  const title = t(lookup(PURCHASE_TITLE_KEYS, entry.kind) ?? 'credits.history.purchaseFallback');

  const storeReceiptKey = lookup(STORE_RECEIPT_KEYS, channel);
  const storeReceiptNote = storeReceiptKey ? t(storeReceiptKey) : null;
  const dateLabel = formatDate(parseTimestamp(entry.date), i18n.language);
  const expiryLabel = entry.expiryDate
    ? keepZoneWithDate(
        t('organization.creditActivity.expiresUtc', {
          date: formatDate(parseTimestamp(entry.expiryDate), i18n.language, { timeZone: 'UTC' }),
        })
      )
    : null;

  return (
    <View className={cn('gap-1.5 px-4 py-3', !last && 'border-b-[0.5px] border-hair-soft')}>
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="small" className="min-w-0 flex-1" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="small" className="text-good">
          {creditAmountLabel(entry.amount_mUsd)}
        </Text>
        {channel === 'card' && (
          <Pressable
            // The audit reads the pressable's own rect, and the glyph is 14 dp,
            // so the box carries the floor itself through the shared inline
            // link box (28 dp, with the negative margin cancelling it back to
            // one line so the row keeps its height). The slop then carries the
            // reach to 44 dp without overlapping the amount beside it.
            className={cn(INLINE_LINK_BOX_CLASS, 'active:opacity-70')}
            hitSlop={RECEIPT_HIT_SLOP}
            disabled={isOpeningReceipt}
            accessibilityRole="button"
            accessibilityState={{ busy: isOpeningReceipt }}
            accessibilityLabel={t('credits.history.receiptA11y', {
              description: title,
              amount: creditAmountLabel(entry.amount_mUsd),
              date: dateLabel,
            })}
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
        <Text variant="caption">{dateLabel}</Text>
        {/* Both lines, not either: a pack Play sold still expires a year after
            purchase, so its row keeps the expiry beside the store that holds
            the receipt. */}
        {expiryLabel != null && <Text variant="caption">{expiryLabel}</Text>}
        {storeReceiptNote != null && <Text variant="caption">{storeReceiptNote}</Text>}
      </View>
    </View>
  );
});

function LedgerLine({
  title,
  typeLabel,
  amountMicrodollars,
  date,
  expiryDate,
  muted,
}: Readonly<{
  title: string;
  /** Absent when the row's own title already names the kind it records. */
  typeLabel?: string;
  amountMicrodollars: number;
  date: string | null;
  /**
   * When the credit this line records runs out. The caption follows the date,
   * the order the purchase row paints its own two lines.
   */
  expiryDate?: string | null;
  muted?: boolean;
}>) {
  const { t } = useTranslation();
  // The same sentence, zone, and isolation the purchase row prints: both rows
  // count down to an instant the account records in UTC.
  const expiryLabel = expiryDate
    ? keepZoneWithDate(
        t('organization.creditActivity.expiresUtc', {
          date: formatDate(parseTimestamp(expiryDate), i18n.language, { timeZone: 'UTC' }),
        })
      )
    : null;

  return (
    <View className={muted ? 'gap-1 pl-4' : 'gap-1'}>
      <View className="flex-row items-center justify-between gap-3">
        <Text variant={muted ? 'muted' : 'small'} className="min-w-0 flex-1" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="small" className={amountMicrodollars >= 0 ? 'text-good' : undefined}>
          {creditAmountLabel(amountMicrodollars)}
        </Text>
      </View>
      <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {date != null && (
          <Text variant="caption">{formatDate(parseTimestamp(date), i18n.language)}</Text>
        )}
        {typeLabel != null && <Text variant="caption">{typeLabel}</Text>}
        {expiryLabel != null && <Text variant="caption">{expiryLabel}</Text>}
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
  last,
}: Readonly<{ deduction: CreditDeduction; grantListed: boolean; last: boolean }>) {
  const { t } = useTranslation();
  // The purchase row carries the grant, its receipt, and its expiry date, so a
  // grant printed again here would read as a second purchase.
  const grant = deduction.purchase;
  const purchase = grantListed ? null : grant;
  // The grant's own name: a free grant is titled from the reason the server
  // recorded, so the row reads in the reader's language, while a paid grant
  // keeps the description its receipts record. An empty stored description
  // still names the row, the way the purchase list already falls back.
  let grantName: string | null = null;
  if (grant != null) {
    grantName = grant.is_free
      ? grantTitle(t, grant.kind)
      : firstNonEmpty(grant.description, t('credits.history.purchaseFallback'));
  }
  const storedDescription = firstNonEmpty(
    deduction.description,
    t('credits.history.deductionFallback')
  );
  // Only a row whose own category is an expiry or a voidance, and whose grant
  // is loaded, gets the framed line: anything else keeps the ledger's own
  // description, which already names what happened. A voided grant was
  // cancelled rather than left to run out, so it never reads as expired.
  const expiryTitle =
    deduction.expiry == null || grant == null
      ? null
      : t(
          deduction.expiry === 'voided'
            ? 'credits.history.voidedGrant'
            : 'credits.history.expiredGrant',
          { description: firstNonEmpty(grantName, storedDescription) }
        );
  // A paid grant keeps the description its receipt records, but an empty one
  // still names the row.
  const rowTitle = firstNonEmpty(grantName, storedDescription);
  // Alone, the expiry line is the whole event: the grant it ended already has
  // its own purchase row above.
  const mainTitle = purchase != null ? rowTitle : (expiryTitle ?? rowTitle);

  return (
    <View className={cn('gap-2 px-4 py-3', !last && 'border-b-[0.5px] border-hair-soft')}>
      <LedgerLine
        title={mainTitle}
        typeLabel={
          purchase ? grantTypeLabel(t, purchase) : deductionTypeLabel(t, deduction.kind)
        }
        amountMicrodollars={purchase ? purchase.amount_mUsd : deduction.amount_mUsd}
        date={purchase?.date ?? deduction.date}
      />
      {purchase != null && (
        <LedgerLine
          title={
            expiryTitle ??
            firstNonEmpty(deduction.description, deductionTypeLabel(t, deduction.kind))
          }
          typeLabel={deductionTypeLabel(t, deduction.kind)}
          amountMicrodollars={deduction.amount_mUsd}
          date={null}
          muted
        />
      )}
    </View>
  );
});

/**
 * One positive grant the person did not buy: a welcome grant, a referral bonus,
 * a Kilo Pass month, an admin grant, or an accounting adjustment. The title
 * already names the kind, so the row carries no type caption. A category with a
 * term prints when it runs out beside the date; a grant that never expires
 * prints the date alone.
 */
export const GrantHistoryRow = memo(function GrantHistoryRow({
  grant,
  last,
}: Readonly<{ grant: CreditGrant; last: boolean }>) {
  // The hook is what re-renders the memoized row when the reader switches the
  // catalog in place, the same way the two sibling rows read their copy.
  const { t } = useTranslation();
  // A kind this app predates still paints a title: the generic grant label is
  // the row name, and an empty one reads as a broken row.
  const title = grantTitle(t, grant.kind);

  return (
    <View className={cn('gap-2 px-4 py-3', !last && 'border-b-[0.5px] border-hair-soft')}>
      <LedgerLine
        title={title}
        amountMicrodollars={grant.amount_mUsd}
        date={grant.date}
        expiryDate={grant.expiryDate}
      />
    </View>
  );
});
