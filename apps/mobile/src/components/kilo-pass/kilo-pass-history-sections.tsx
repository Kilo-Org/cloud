import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { AlertCircle } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate, formatPrefixedMoney } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  type KiloPassBillingHistory,
  type KiloPassCreditHistory,
} from '@/lib/hooks/use-kilo-pass-history';
import { type KiloPassBillingEntry, type KiloPassCreditEntry } from '@/lib/kilo-pass/management';
import { kiloPassTierLabel } from '@/lib/kilo-pass/state';
import { isRetryableTrpcError } from '@/lib/trpc-error';
import { capitalize, firstNonEmpty, parseTimestamp } from '@/lib/utils';

function HistorySection({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return <Section label={title}>{children}</Section>;
}

function historyDate(value: string): string {
  return formatDate(parseTimestamp(value), i18n.language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function HistoryLine({
  title,
  date,
  amount,
}: Readonly<{ title: string; date: string; amount: string }>) {
  return (
    <KvRow
      label={title}
      // The description the server returns can be a sentence; the amount and
      // the date are the column a reader scans, so the title yields its width
      // to them instead of pushing them out of the row.
      labelShrink
      value={amount}
      valueFace="numeric"
      trailing={<Text variant="caption">{date}</Text>}
    />
  );
}

function SectionPending() {
  return (
    <RowGroup>
      <RowSkeleton />
      <RowSkeleton />
    </RowGroup>
  );
}

/**
 * A load that failed: icon, reason, and a retry for it when one can help.
 *
 * A failed later page keeps the rows the list already has and says more could
 * not be loaded; a failed first page has nothing on screen and says so, rather
 * than claiming more could not be loaded when nothing loaded at all.
 *
 * A failure whose tRPC code is terminal gets the reason alone, because the
 * caller passes no retry: offering Retry there would promise an action that
 * cannot succeed.
 */
function SectionError({
  message,
  onRetry,
}: Readonly<{ message: string; onRetry?: (() => void) | undefined }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <AlertCircle size={16} color={colors.destructive} />
        <Text variant="muted" className="min-w-0 flex-1">
          {message}
        </Text>
      </View>
      {onRetry ? (
        <Button
          variant="outline"
          size="action"
          accessibilityLabel={t('common.retry')}
          onPress={onRetry}
        >
          <Text>{t('common.retry')}</Text>
        </Button>
      ) : null}
    </View>
  );
}

/**
 * A description without the parts of the server's sentence that are not for the
 * reader, or '' when nothing readable is left.
 *
 * The product name comes off because the screen header already prints it, and a
 * row that repeats it buries the part that tells the rows apart, the credits'
 * own kind. The trailing parenthesis comes off because it carries internal
 * identifiers — the plan id, the cadence, a streak, the issue month — while the
 * header names the plan and cadence and the row prints its own date. Left in, it
 * leaks identifiers into every locale, untranslated.
 *
 * The remainder keeps its sentence capital so the title still reads as a title.
 */
function cleanedRowTitle(description: string): string {
  const title = description
    .replace(/^kilo pass\s+/i, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();
  // The first grapheme is display text, so its case is the active locale's.
  return title.length === 0 ? '' : capitalize(title);
}

function CreditHistoryLine({ entry }: Readonly<{ entry: KiloPassCreditEntry }>) {
  const title = firstNonEmpty(cleanedRowTitle(entry.description), i18n.t('common.creditHistory'));
  return (
    <HistoryLine
      title={title}
      date={historyDate(entry.date)}
      amount={formatPrefixedMoney(entry.amountUsd, i18n.language)}
    />
  );
}

/** The catalog key for every invoice line kind the server classifies. */
const BILLING_ROW_TITLE_KEYS = {
  initial: 'kiloPass.manage.billingRowInitial',
  renewal: 'kiloPass.manage.billingRowRenewal',
  trial: 'kiloPass.manage.billingRowTrial',
  upgrade: 'kiloPass.manage.billingRowUpgrade',
  // The line the server could not type still has row copy: the charge was the
  // subscription itself.
  unknown: 'kiloPass.manage.billingRowSubscription',
} as const satisfies Record<string, string>;

/** True for a line kind this build has row copy for. */
function isNamedBillingRowKind(kind: string): kind is keyof typeof BILLING_ROW_TITLE_KEYS {
  // Every kind the server classifies is named here; the wire itself is an open
  // set, so a kind this build has never seen still falls back to the description.
  return Object.hasOwn(BILLING_ROW_TITLE_KEYS, kind);
}

/**
 * A billing row title.
 *
 * The provider's description is a sentence written for its own dashboard: it
 * names the product, the plan's internal id, the cadence and sometimes a streak,
 * none of which a row already under the Kilo Pass header needs to repeat. The
 * server types the invoice line instead, so the row says what the charge was — a
 * trial, the first charge, a renewal, a plan change, or the subscription a line
 * the server could not otherwise type paid for — and the tier it billed, in the
 * reader's language. Every kind the server classifies has row copy, so only a row
 * with no typed line at all falls back to the provider's sentence, cleaned the
 * way a credit row is.
 */
function billingRowTitle(entry: KiloPassBillingEntry): string {
  const line = entry.kind === 'stripe' ? entry.line : null;
  if (line && isNamedBillingRowKind(line.kind)) {
    const tier = line.tier ? kiloPassTierLabel(line.tier) : i18n.t('kiloPass.title');
    return i18n.t(BILLING_ROW_TITLE_KEYS[line.kind], { tier });
  }
  return firstNonEmpty(cleanedRowTitle(entry.description ?? ''), i18n.t('kiloPass.title'));
}

function BillingHistoryLine({ entry }: Readonly<{ entry: KiloPassBillingEntry }>) {
  const title = billingRowTitle(entry);
  const amount =
    entry.kind === 'stripe'
      ? formatPrefixedMoney(entry.amountCents / 100, i18n.language)
      : formatPrefixedMoney(Math.abs(fromMicrodollars(entry.amountMicrodollars)), i18n.language);
  return <HistoryLine title={title} date={historyDate(entry.date)} amount={amount} />;
}

/**
 * The credits each Kilo Pass month has granted, newest first.
 */
export function KiloPassCreditHistorySection({
  history,
}: Readonly<{ history: KiloPassCreditHistory }>) {
  const { t } = useTranslation();
  const { query, entries, hasMore } = history;
  const firstPageFailed = query.isError && entries.length === 0;
  const retryable = isRetryableTrpcError(query.error);

  let body: ReactNode = null;
  if (query.isPending) {
    body = <SectionPending />;
  } else if (firstPageFailed) {
    body = (
      <SectionError
        message={t('kiloPass.manage.creditHistoryError')}
        onRetry={
          retryable
            ? () => {
                query.refetch();
              }
            : undefined
        }
      />
    );
  } else if (entries.length === 0) {
    body = <Text variant="muted">{t('kiloPass.manage.creditHistoryEmpty')}</Text>;
  } else {
    body = (
      <RowGroup>
        {entries.map(entry => (
          <CreditHistoryLine key={entry.id} entry={entry} />
        ))}
      </RowGroup>
    );
  }

  return (
    <HistorySection title={t('common.creditHistory')}>
      {body}
      {hasMore && !query.isFetchNextPageError && (
        <Button
          variant="outline"
          size="sm"
          loading={query.isFetchingNextPage}
          onPress={() => {
            query.fetchNextPage();
          }}
          accessibilityLabel={t('common.loadMore')}
        >
          <Text>{t('common.loadMore')}</Text>
        </Button>
      )}
      {query.isFetchNextPageError && (
        <SectionError
          message={t('common.couldnTLoadMore')}
          onRetry={
            retryable
              ? () => {
                  query.fetchNextPage();
                }
              : undefined
          }
        />
      )}
    </HistorySection>
  );
}

/** The Stripe invoices a Stripe-billed pass has produced, newest first. */
export function KiloPassBillingHistorySection({
  history,
}: Readonly<{ history: KiloPassBillingHistory }>) {
  const { t } = useTranslation();
  const { query, entries, hasMore } = history;
  const firstPageFailed = query.isError && entries.length === 0;
  const retryable = isRetryableTrpcError(query.error);

  let body: ReactNode = null;
  if (query.isPending) {
    body = <SectionPending />;
  } else if (firstPageFailed) {
    body = (
      <SectionError
        message={t('kiloPass.manage.billingHistoryError')}
        onRetry={
          retryable
            ? () => {
                query.refetch();
              }
            : undefined
        }
      />
    );
  } else if (entries.length === 0) {
    body = <Text variant="muted">{t('kiloPass.manage.billingHistoryEmpty')}</Text>;
  } else {
    body = (
      <RowGroup>
        {entries.map(entry => (
          <BillingHistoryLine key={entry.id} entry={entry} />
        ))}
      </RowGroup>
    );
  }

  return (
    <HistorySection title={t('kiloPass.manage.billingHistory')}>
      {body}
      {hasMore && !query.isFetchNextPageError && (
        <Button
          variant="outline"
          size="sm"
          loading={query.isFetchingNextPage}
          onPress={() => {
            query.fetchNextPage();
          }}
          accessibilityLabel={t('common.loadMore')}
        >
          <Text>{t('common.loadMore')}</Text>
        </Button>
      )}
      {query.isFetchNextPageError && (
        <SectionError
          message={t('common.couldnTLoadMore')}
          onRetry={
            retryable
              ? () => {
                  query.fetchNextPage();
                }
              : undefined
          }
        />
      )}
    </HistorySection>
  );
}
