import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { memo, type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { canViewOrgAuditLog } from '@/components/organization/organization-settings-rows';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { ScrollText } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatClockTime, formatDate } from '@/lib/format';
import { type OrgAuditLogEntry, useOrgAuditLogPage } from '@/lib/hooks/use-org-billing-queries';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { parseTimestamp } from '@/lib/utils';

// FlashList takes `contentContainerStyle` (no className), so the `px-6 pt-4`
// inset maps to its pixel values; the tab bar's own bottom padding rides on the
// footer, which `gap` would not cover.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingHorizontal: 24, paddingTop: 16 } satisfies ViewStyle;

const AUDIT_DATE = { year: 'numeric', month: 'short', day: 'numeric' } as const;

const RowSeparator = () => <View className="h-3" />;

function RowSkeleton() {
  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-3/4 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-1/3 rounded bg-muted-soft" />
    </View>
  );
}

/** `created_at` arrives as a PostgreSQL timestamp; Hermes needs `parseTimestamp`. */
function formatAuditTime(createdAt: string): string {
  const date = parseTimestamp(createdAt);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const day = formatDate(date, i18n.language, AUDIT_DATE);
  return `${day} · ${formatClockTime(date, i18n.language)}`;
}

const AuditLogRow = memo(function AuditLogRow({ entry }: Readonly<{ entry: OrgAuditLogEntry }>) {
  const actor = entry.actor_email ?? entry.actor_name;
  const time = formatAuditTime(entry.created_at);
  const meta = actor ? `${actor} · ${time}` : time;
  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <Text className="text-sm font-medium text-foreground">{entry.message}</Text>
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
        {entry.action}
      </Text>
      {meta.length === 0 ? null : (
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {meta}
        </Text>
      )}
    </View>
  );
});

/**
 * The organization's audit log, read-only.
 *
 * The web page is the same list of `organization_audit_logs` rows; this screen
 * pages it through `organizations.auditLogs.list` with that procedure's own
 * `before` cursor. It carries the web sidebar's gate: a billing role on the
 * enterprise plan.
 */
export function OrganizationAuditLogScreen() {
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const allowed = org != null && canViewOrgAuditLog(role, org.plan);
  const { query, entries, hasMore } = useOrgAuditLogPage(organizationId, allowed);
  const paddingBottom = useTabBarBottomPadding();

  // `AuditLogRow` is memoized at module scope, so one identity across data
  // updates keeps every unchanged row from re-rendering.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<OrgAuditLogEntry>) => <AuditLogRow entry={item} />,
    []
  );

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.auditLog.title')} />;
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.auditLog.title')} />
        <PermissionDenied description={t('organization.auditLog.permissionDenied')} />
      </View>
    );
  }

  const isFirstPageError = query.isError && (query.data?.pages.length ?? 0) === 0;
  // A later-page failure keeps the loaded rows and offers an inline retry;
  // reading `isFetchNextPageError` rather than `isError` keeps a failed
  // background refetch of page one from replacing the list.
  const isLaterPageError = query.isFetchNextPageError;

  let body: ReactNode = null;
  if (query.isPending) {
    body = (
      <View className="gap-3 px-6 pt-4">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </View>
    );
  } else if (isFirstPageError) {
    body = <QueryError onRetry={() => void query.refetch()} isRetrying={query.isFetching} />;
  } else if (entries.length === 0 && !hasMore && !isLaterPageError) {
    body = (
      <EmptyState
        icon={ScrollText}
        title={t('organization.auditLog.emptyTitle')}
        description={t('organization.auditLog.emptyDescription')}
      />
    );
  } else {
    const footer = (
      <View className="pt-3">
        {hasMore && !isLaterPageError ? (
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
              {t('organization.auditLog.truncated')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void query.fetchNextPage()}
              loading={query.isFetchingNextPage}
              accessibilityLabel={t('common.loadMore')}
            >
              <Text>{t('common.loadMore')}</Text>
            </Button>
          </View>
        ) : null}
        {isLaterPageError ? (
          <View className="items-center gap-3 px-6 py-4">
            <Text variant="muted" className="text-center text-xs">
              {t('common.couldnTLoadMore')}
            </Text>
            <Button
              variant="outline"
              size="sm"
              onPress={() => void query.fetchNextPage()}
              loading={query.isFetchingNextPage}
              accessibilityLabel={t('common.retry')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        ) : null}
        <View style={{ height: paddingBottom }} pointerEvents="none" />
      </View>
    );

    body = (
      <FlashList
        style={listStyle}
        data={entries}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        getItemType={() => 'auditLog'}
        ItemSeparatorComponent={RowSeparator}
        contentContainerStyle={listContentContainerStyle}
        ListFooterComponent={footer}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.auditLog.title')} />
      {body}
    </View>
  );
}
