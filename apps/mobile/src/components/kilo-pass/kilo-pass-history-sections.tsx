import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate, formatMoneyFromCents, formatPrefixedMoney } from '@/lib/format';
import {
  useKiloPassBillingHistory,
  useKiloPassCreditHistory,
} from '@/lib/hooks/use-kilo-pass-history';
import type { KiloPassBillingEntry, KiloPassCreditEntry } from '@/lib/kilo-pass/management';
import { firstNonEmpty, parseTimestamp } from '@/lib/utils';

function HistorySection({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {title}
      </Text>
      <View className="gap-3 rounded-lg bg-secondary p-3">{children}</View>
    </View>
  );
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
    <View className="gap-0.5">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text className="text-sm text-foreground">{amount}</Text>
      </View>
      <Text className="text-xs text-muted-foreground">{date}</Text>
    </View>
  );
}

function SectionPending({ children }: Readonly<{ children: ReactNode }>) {
  return <View className="gap-2">{children}</View>;
}

/**
 * A page that failed keeps the rows it already has and offers a retry under
 * them, the same way the paged lists elsewhere do.
 */
function SectionError({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useTranslation();
  return (
    <Pressable
      className="flex-row items-center gap-2 active:opacity-70"
      accessibilityRole="button"
      accessibilityLabel={t('common.retry')}
      onPress={onRetry}
    >
      <Text className="text-sm text-muted-foreground">{t('common.couldnTLoadMore')}</Text>
      <Text className="text-sm text-primary">{t('common.retry')}</Text>
    </Pressable>
  );
}

function CreditHistoryLine({ entry }: Readonly<{ entry: KiloPassCreditEntry }>) {
  return (
    <HistoryLine
      title={firstNonEmpty(entry.description, i18n.t('common.creditHistory'))}
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
      ? formatMoneyFromCents(entry.amountCents, i18n.language)
      : formatPrefixedMoney(Math.abs(fromMicrodollars(entry.amountMicrodollars)), i18n.language);
  return <HistoryLine title={title} date={historyDate(entry.date)} amount={amount} />;
}

/** The credits each Kilo Pass month has granted, newest first. */
export function KiloPassCreditHistorySection() {
  const { t } = useTranslation();
  const { query, entries, hasMore } = useKiloPassCreditHistory(true);
  const firstPageFailed = query.isError && entries.length === 0;

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <SectionPending>
        <Skeleton className="h-4 w-40 rounded" />
        <Skeleton className="h-4 w-32 rounded" />
      </SectionPending>
    );
  } else if (firstPageFailed) {
    body = (
      <SectionError
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (entries.length === 0) {
    body = (
      <Text variant="muted" className="text-sm">
        {t('kiloPass.manage.creditHistoryEmpty')}
      </Text>
    );
  } else {
    body = entries.map(entry => <CreditHistoryLine key={entry.id} entry={entry} />);
  }

  return (
    <HistorySection title={t('common.creditHistory')}>
      {body}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          loading={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
          accessibilityLabel={t('common.loadMore')}
        >
          <Text>{t('common.loadMore')}</Text>
        </Button>
      )}
      {query.isFetchNextPageError && (
        <SectionError
          onRetry={() => {
            void query.fetchNextPage();
          }}
        />
      )}
    </HistorySection>
  );
}

/** The Stripe invoices a Stripe-billed pass has produced, newest first. */
export function KiloPassBillingHistorySection() {
  const { t } = useTranslation();
  const { query, entries, hasMore } = useKiloPassBillingHistory(true);
  const firstPageFailed = query.isError && entries.length === 0;

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <SectionPending>
        <Skeleton className="h-4 w-40 rounded" />
        <Skeleton className="h-4 w-32 rounded" />
      </SectionPending>
    );
  } else if (firstPageFailed) {
    body = (
      <SectionError
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (entries.length === 0) {
    body = (
      <Text variant="muted" className="text-sm">
        {t('kiloPass.manage.billingHistoryEmpty')}
      </Text>
    );
  } else {
    body = entries.map(entry => <BillingHistoryLine key={entry.id} entry={entry} />);
  }

  return (
    <HistorySection title={t('kiloPass.manage.billingHistory')}>
      {body}
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          loading={query.isFetchingNextPage}
          onPress={() => void query.fetchNextPage()}
          accessibilityLabel={t('common.loadMore')}
        >
          <Text>{t('common.loadMore')}</Text>
        </Button>
      )}
      {query.isFetchNextPageError && (
        <SectionError
          onRetry={() => {
            void query.fetchNextPage();
          }}
        />
      )}
    </HistorySection>
  );
}
