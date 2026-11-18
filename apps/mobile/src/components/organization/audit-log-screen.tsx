import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { auditActionLabel } from '@/components/organization/audit-log-action-label';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { canViewOrgAuditLog } from '@/components/organization/organization-settings-rows';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ChevronDown, ChevronUp, ScrollText } from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatClockTime, formatDate } from '@/lib/format';
import { useManualRefresh } from '@/lib/hooks/use-manual-refresh';
import { type OrgAuditLogEntry, useOrgAuditLogPage } from '@/lib/hooks/use-org-billing-queries';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { parseTimestamp } from '@/lib/utils';

// The cards carry the page gutter themselves. The tab bar's own bottom padding
// rides on the footer, which `gap` would not cover, and the body's top pad sits
// on a header component because a FlashList cannot take a class on its content
// container.
const listStyle = { flex: 1 } satisfies ViewStyle;

const ListTopPad = () => <View className="pt-3" />;

const AUDIT_DATE = { year: 'numeric', month: 'short', day: 'numeric' } as const;

const RowSeparator = () => <View className="h-3" />;

function RowSkeleton() {
  return (
    <Card className="mx-4">
      <Skeleton className="h-4 w-3/4 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-1/3 rounded bg-muted-soft" />
    </Card>
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
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [expanded, setExpanded] = useState(false);
  const actor = entry.actor_email ?? entry.actor_name;
  const time = formatAuditTime(entry.created_at);
  const meta = actor ? `${actor} · ${time}` : time;
  const eventName = auditActionLabel(t, entry.action);
  // The server's message for the creation action is "Organization <name>
  // created", which only restates the event name already shown above it. Every
  // row of this log belongs to this organization, so the row shows neither that
  // English sentence nor a name a later rename would change.
  const showsDetail = entry.action !== 'organization.created';
  const metaLine =
    meta.length === 0 ? null : (
      <Text variant="caption" numberOfLines={1}>
        {meta}
      </Text>
    );
  if (!showsDetail) {
    return (
      <Card className="mx-4">
        <Text className="text-sm font-medium text-foreground">{eventName}</Text>
        {metaLine}
      </Card>
    );
  }
  // The message runs past two lines for most events, and nothing else in the
  // app carries it, so the row itself is the detail view: it starts clamped and
  // a press shows the whole sentence. The row cannot know whether the message
  // fits two lines without measuring it — a clamped text reports only the lines
  // it drew — so every event row offers the disclosure, and the reader who
  // needs nothing more loses nothing by ignoring it.
  return (
    <Pressable
      onPress={() => {
        setExpanded(value => !value);
      }}
      accessibilityRole="button"
      // The clamp is visual only: a reader hears the whole event whether or not
      // the row is open.
      accessibilityLabel={[eventName, entry.message, meta].filter(Boolean).join('. ')}
      accessibilityState={{ expanded }}
      className="mx-4 active:opacity-70"
    >
      <Card>
        <View className="flex-row items-center gap-2">
          {expanded ? (
            <ChevronUp size={16} color={colors.mutedForeground} />
          ) : (
            <ChevronDown size={16} color={colors.mutedForeground} />
          )}
          <Text className="min-w-0 flex-1 text-sm font-medium text-foreground">{eventName}</Text>
        </View>
        <Text variant="caption" numberOfLines={expanded ? undefined : 2}>
          {entry.message}
        </Text>
        {metaLine}
      </Card>
    </Pressable>
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

  // An audit entry can be written while this screen is open (another admin
  // changes settings on the web), so the pull is the reader's way to ask for
  // the new events without leaving the list.
  const [refreshing, onRefresh] = useManualRefresh(query.refetch, t('common.couldNotRefresh'));
  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />;

  // `AuditLogRow` is memoized at module scope, so one identity across data
  // updates keeps every unchanged row from re-rendering. The row reads `t`
  // itself instead of taking it as a prop: `useTranslation` subscribes each row
  // to a language change, which a prop that never changes could not.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<OrgAuditLogEntry>) => <AuditLogRow entry={item} />,
    []
  );

  if (isResolving || organizationId == null || org == null) {
    return (
      <OrganizationBoundary
        title={t('organization.auditLog.title')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
    );
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('organization.auditLog.title')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
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
      <View className="gap-3 pt-3">
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
        refreshControl={refreshControl}
      />
    );
  } else {
    const footer = (
      <View className="pt-3">
        {hasMore && !isLaterPageError ? (
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="caption" className="text-center">
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
          <View className="items-center gap-3 px-4 py-4">
            <Text variant="caption" className="text-center">
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
        ListHeaderComponent={<ListTopPad />}
        refreshControl={refreshControl}
        ListFooterComponent={footer}
      />
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.auditLog.title')} backFallback={ORGANIZATION_HUB_PATH} />
      {body}
    </View>
  );
}
