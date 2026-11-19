import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { memo, type ReactNode, useCallback, useRef, useState } from 'react';
import { Pressable, type TextLayoutEvent, View, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/empty-state';
import { auditLogDetailFor } from '@/components/organization/audit-log-detail';
import { auditActionLabel } from '@/components/organization/audit-log-action-label';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { canViewOrgAuditLog } from '@/components/organization/organization-settings-rows';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
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

// FlashList takes `contentContainerStyle` (no className), so the skeleton's and
// the empty and footer blocks' `px-6 pt-4` inset is spelled in pixels here.
// NativeWind's native rem is 14, which makes px-6 21 dp and pt-4 14 dp; 24/16 is
// the web rem and leaves the rows 3 dp inside those blocks. The tab
// bar's own bottom padding rides on the footer, which `gap` would not cover.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingHorizontal: 21, paddingTop: 14 } satisfies ViewStyle;

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
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [expanded, setExpanded] = useState(false);
  // The collapsed detail must size itself to its painted lines, not to a fixed
  // two-line clamp: a detail whose text exactly fills its first line (a long
  // German role-change sentence) makes Android allocate a second, empty line
  // box inside the `numberOfLines={2}` clamp, and that card stands a line
  // taller than its neighbors with a blank gap before the meta line. The
  // layout callback counts the lines that actually hold glyphs — the empty
  // trailing box carries no text — and the collapsed clamp becomes that count,
  // capped at two: one- and two-line details size to their content, and only a
  // detail that really runs past two lines keeps the full clamp and the
  // press-to-expand affordance. The stored count is keyed to the sentence it
  // measured: FlashList recycles row instances across entries, so a cell that
  // held a short detail must not clamp the longer sentence it renders next —
  // a count from another text reads as unknown and the clamp starts at two.
  // `expanded` rows measure unclamped and could report a longer count, so
  // their reports never move the collapsed clamp.
  const [measured, setMeasured] = useState<{ text: string; lines: number } | null>(null);
  // The callback reads the expanded flag through a ref: a state read would
  // need the callback in the dependency array, and a re-created callback makes
  // the memoized row re-render on every toggle for nothing. The flag flips
  // synchronously with the press, so no report from the expanded layout can
  // land after the collapse begins. The sentence rides a ref too: the callback
  // stores the text its measurement belongs to, so a recycled cell never
  // applies a count measured for another entry.
  const expandedRef = useRef(false);
  const measuredTextRef = useRef('');
  const onDetailLayout = useCallback((e: TextLayoutEvent) => {
    if (expandedRef.current) {
      return;
    }
    const lines = Math.max(
      1,
      e.nativeEvent.lines.filter(line => line.text.trim().length > 0).length
    );
    setMeasured(current =>
      current?.lines === lines ? current : { text: measuredTextRef.current, lines }
    );
  }, []);
  const actor = entry.actor_email ?? entry.actor_name;
  const time = formatAuditTime(entry.created_at);
  const eventName = auditActionLabel(t, entry.action);
  // The detail is built from the row's structured `details`, in the reader's
  // language. The server's English `message` never renders: the server writes
  // it for the web audit page and operators reading raw rows, and even a row
  // whose message IS the reader's language would speak in the writer's
  // sentence, not the app's. The creation action's detail only restates the
  // event name, so — as before — no row shows it.
  const detail = auditLogDetailFor(t, entry.details);
  // The clamp reads this ref from the layout callback, which fires after the
  // render that changed the sentence; keeping it in sync here makes every
  // stored count name the sentence on screen when it was measured.
  measuredTextRef.current = detail ?? '';
  const clamp =
    expanded || detail == null
      ? undefined
      : (measured?.text === detail && measured.lines) || 2;
  const showsDetail = entry.action !== 'organization.created' && detail != null;
  // The actor and the time render as two elements in one row, never one
  // interpolated string: the row shrinks the actor, not the time, and each
  // keeps its own reading order. One string put the localized date inside the
  // left-to-right email run, so under Arabic its parts read out of order, and
  // the single-line clamp put the ellipsis on the time — the part that tells
  // the entries apart — while the repeated email stayed whole.
  const metaLine =
    actor || time ? (
      <View className="flex-row items-center gap-2">
        {actor ? (
          // RN defaults `flexShrink` to 0; `min-w-0 shrink` lets the long
          // repeated email give up width and truncate instead of pushing the
          // time off the line.
          <Text className="min-w-0 shrink text-xs text-muted-foreground" numberOfLines={1}>
            {actor}
          </Text>
        ) : null}
        {time ? (
          <Text className="shrink-0 text-xs text-muted-foreground" numberOfLines={1}>
            {time}
          </Text>
        ) : null}
      </View>
    ) : null;
  if (!showsDetail) {
    return (
      <View className="gap-1 rounded-lg bg-secondary p-3">
        <Text className="text-sm font-medium text-foreground">{eventName}</Text>
        {metaLine}
      </View>
    );
  }
  // The detail can run past two lines, and nothing else in the app carries it,
  // so the row itself is the detail view: it starts clamped to its painted
  // lines and a press shows the whole sentence. Until the first layout pass
  // reports, the clamp stays at two; a detail the clamp hides keeps its
  // disclosure, and the reader who needs nothing more loses nothing by
  // ignoring it.
  return (
    <Pressable
      onPress={() => {
        setExpanded(value => {
          expandedRef.current = !value;
          return !value;
        });
      }}
      accessibilityRole="button"
      // The clamp is visual only: a reader hears the whole event whether or not
      // the row is open.
      accessibilityLabel={[eventName, detail, [actor, time].filter(Boolean).join(', ')]
        .filter(Boolean)
        .join('. ')}
      accessibilityState={{ expanded }}
      className="gap-1 rounded-lg bg-secondary p-3 active:opacity-70"
    >
      <View className="flex-row items-center gap-2">
        {expanded ? (
          <ChevronUp size={16} color={colors.mutedForeground} />
        ) : (
          <ChevronDown size={16} color={colors.mutedForeground} />
        )}
        <Text className="min-w-0 flex-1 text-sm font-medium text-foreground">{eventName}</Text>
      </View>
      <Text
        className="text-xs text-muted-foreground"
        numberOfLines={clamp}
        onTextLayout={onDetailLayout}
      >
        {detail}
      </Text>
      {metaLine}
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
        refreshControl={refreshControl}
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
