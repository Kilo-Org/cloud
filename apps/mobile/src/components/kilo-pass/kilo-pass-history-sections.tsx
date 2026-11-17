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
      value={amount}
      valueFace="text"
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
 * A row title without the parts of the server's description that are not for
 * the reader.
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
function creditRowTitle(description: string): string {
  const title = description
    .replace(/^kilo pass\s+/i, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim();
  if (title.length === 0) {
    return i18n.t('common.creditHistory');
  }
  // The first grapheme is display text, so its case is the active locale's.
  return capitalize(title);
}

function CreditHistoryLine({ entry }: Readonly<{ entry: KiloPassCreditEntry }>) {
  return (
    <HistoryLine
      title={creditRowTitle(entry.description)}
      date={historyDate(entry.date)}
      amount={formatPrefixedMoney(entry.amountUsd, i18n.language)}
    />
  );
}

function BillingHistoryLine({ entry }: Readonly<{ entry: KiloPassBillingEntry }>) {
  const title =
    entry.kind === 'stripe'
      ? firstNonEmpty(entry.description, i18n.t('kiloPass.title'))
      : entry.description;
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
