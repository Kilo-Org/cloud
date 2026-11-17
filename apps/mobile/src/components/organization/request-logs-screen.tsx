import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { DirectionalChevronLeft, DirectionalChevronRight } from '@/components/ui/directional-icons';
import { Logs } from '@/components/ui/icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateLtrBidiText } from '@/lib/bidi';
import {
  formatClockTime,
  formatDate,
  formatNumber,
  formatPrefixedUsd,
  UNMEASURED_VALUE,
} from '@/lib/format';
import { type OrgRequestLogEntry, useOrgRequestLogs } from '@/lib/hooks/use-org-billing-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { ORGANIZATION_HUB_PATH } from '@/lib/organization-navigation';
import { isRetryableTrpcError, trpcErrorVariant, type TrpcErrorVariant } from '@/lib/trpc-error';
import { parseTimestamp } from '@/lib/utils';

/**
 * The hour the procedure lists: `organizations.requestLogs.list` answers the
 * rows created in the hour before `startTime`, so a window end is the screen's
 * paging control and one step is one hour.
 */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The server caps one window at 100 rows (`REQUEST_LOGS_LIMIT`,
 * `REQUEST_LOGS_WINDOW_HOURS` in apps/web). A full window therefore means older
 * rows inside it exist and the window is the only way to reach them.
 */
const REQUEST_LOG_LIMIT = 100;

/**
 * The procedure refuses a start time more than `REQUEST_LOGS_START_TIME_MAX_AGE_DAYS`
 * (365, apps/web) before its own clock, which runs later than this screen's
 * mount-time anchor. The stepper keeps an hour of margin, so the oldest window
 * it opens still names a start time the server accepts.
 */
const HISTORY_DAYS = 365;

/** Whether a window ending at `windowEndMs` is inside the procedure's age bound. */
export function canStepOlderTo(windowEndMs: number, anchorMs: number): boolean {
  return windowEndMs >= anchorMs - (HISTORY_DAYS * 24 - 1) * HOUR_MS;
}

// FlashList takes `contentContainerStyle` (no className), so the header's and
// the skeleton's `px-6 pt-4` inset is spelled in pixels here. NativeWind's
// native rem is 14, which makes px-6 21 dp and pt-4 14 dp; writing 24/16 (the
// web rem) puts the cards 3 dp inside the date and the stepper above them. The
// tab bar's own bottom padding rides on the footer, which `gap` would not cover.
const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingHorizontal: 21, paddingTop: 14 } satisfies ViewStyle;

const WINDOW_DATE = { weekday: 'short', month: 'short', day: 'numeric' } as const;

const RowSeparator = () => <View className="h-3" />;

function RowSkeleton() {
  return (
    <View className="gap-2 rounded-lg bg-secondary p-3">
      <Skeleton className="h-4 w-3/4 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-1/2 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-1/3 rounded bg-muted-soft" />
    </View>
  );
}

/**
 * The body one window paints. A window keeps the rows it already holds while a
 * refetch runs, so only a window with no data at all reads as loading or as a
 * failure; every outcome that leaves no rows to show names its own recovery.
 */
type RequestLogsBody =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'list'; rows: readonly OrgRequestLogEntry[]; truncated: boolean }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'retryable'; variant: TrpcErrorVariant }>
  | Readonly<{ kind: 'refused'; variant: TrpcErrorVariant }>;

function requestLogsBody(
  rows: readonly OrgRequestLogEntry[] | undefined,
  error: unknown
): RequestLogsBody {
  if (rows !== undefined) {
    return rows.length === 0
      ? { kind: 'empty' }
      : { kind: 'list', rows, truncated: rows.length >= REQUEST_LOG_LIMIT };
  }
  if (error === null || error === undefined) {
    return { kind: 'loading' };
  }
  const variant = trpcErrorVariant(error);
  return isRetryableTrpcError(error)
    ? { kind: 'retryable', variant }
    : { kind: 'refused', variant };
}

/** The name the web table prints for a request's user, with its own fallbacks. */
const RequestLogRow = memo(function RequestLogRow({
  entry,
}: Readonly<{ entry: OrgRequestLogEntry }>) {
  const { t } = useTranslation();
  const locale = i18n.language;
  const created = parseTimestamp(entry.created_at);
  const time = Number.isNaN(created.getTime())
    ? UNMEASURED_VALUE
    : formatClockTime(created, locale);
  // Six fraction digits, as the web table prints a request's cost: a gateway
  // request can cost less than a cent, and two digits would round it to zero.
  const cost = formatPrefixedUsd(fromMicrodollars(entry.cost_microdollars), locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
  const tokens = t('organization.requestLogs.tokens', {
    input: formatNumber(entry.input_tokens, locale),
    output: formatNumber(entry.output_tokens, locale),
  });
  // The web table names a request's user by name, then email, then id, and skips
  // an empty value rather than printing a blank cell.
  const userName =
    [entry.user.name, entry.user.email, entry.user.id].find(Boolean) ?? UNMEASURED_VALUE;

  return (
    <View className="gap-1 rounded-lg bg-secondary p-3">
      <View className="flex-row items-baseline gap-3">
        <Text className="flex-1 font-mono text-xs text-foreground" numberOfLines={1}>
          {entry.model ?? UNMEASURED_VALUE}
        </Text>
        <Text className="shrink-0 text-sm font-medium tabular-nums text-foreground">{cost}</Text>
      </View>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
          {userName}
        </Text>
        <Text className="shrink-0 text-xs text-muted-foreground" numberOfLines={1}>
          {entry.provider ?? UNMEASURED_VALUE}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        {/* The time carries the same ` · ` the token pair uses, so the line
            reads as one series instead of a gap and a lone `in · out` dot. The
            dot trails the isolated time, which puts it on the side the row
            continues in either direction. */}
        <Text className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {`${isolateLtrBidiText(time)} ·`}
        </Text>
        <Text className="flex-1 text-xs tabular-nums text-muted-foreground" numberOfLines={1}>
          {tokens}
        </Text>
        {entry.is_user_byok ? (
          // Muted text with no box: `bg-muted` is the card's own `bg-secondary`
          // in both themes, so a filled badge paints nothing, and its padding
          // pulled the marker inside the right edge that cost and provider
          // share while adding a line of height the other rows lack.
          <Text className="shrink-0 text-xs text-muted-foreground">
            {t('organization.requestLogs.byok')}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

/**
 * The organization's request logs, read-only.
 *
 * The web page is the same table over `organizations.requestLogs.list`, which
 * answers the newest 100 gateway requests from the hour before a start time.
 * This screen turns that window into the phone's paging control — one step per
 * hour, backwards from now — and keeps the table's own fields on each row:
 * time, user, model, provider, cost, input and output tokens, and whether the
 * request used the user's own key.
 *
 * It carries the web page's gate, the billing role, and repeats it to itself
 * because a deep link can reach the screen without the row that opens it.
 */
export function OrganizationRequestLogsScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  // The window's newest end. The anchor is captured once, so "Newer" has a
  // fixed edge to return to instead of sliding with the clock.
  const [anchorMs] = useState(() => Date.now());
  const [windowEndMs, setWindowEndMs] = useState(anchorMs);
  const allowed = canManageOrganizationBilling(role);
  const logs = useOrgRequestLogs(organizationId, new Date(windowEndMs).toISOString(), allowed);
  const paddingBottom = useTabBarBottomPadding();
  const body = requestLogsBody(logs.data, logs.error);

  // `RequestLogRow` is memoized at module scope, so one identity across data
  // updates keeps every unchanged row from re-rendering.
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<OrgRequestLogEntry>) => <RequestLogRow entry={item} />,
    []
  );

  if (isResolving || organizationId == null || org == null) {
    return (
      <OrganizationBoundary
        title={t('organization.settingsOnWeb.requestLogs')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
    );
  }

  if (!allowed) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('organization.settingsOnWeb.requestLogs')}
          backFallback={ORGANIZATION_HUB_PATH}
        />
        <PermissionDenied description={t('organization.requestLogs.permissionDenied')} />
      </View>
    );
  }

  const windowStart = new Date(windowEndMs - HOUR_MS);
  const windowEnd = new Date(windowEndMs);
  const canStepOlder = canStepOlderTo(windowEndMs - HOUR_MS, anchorMs);
  const canStepNewer = windowEndMs < anchorMs;
  const refreshControl = (
    <RefreshControl
      refreshing={logs.isFetching && !logs.isPending}
      onRefresh={() => void logs.refetch()}
    />
  );

  // One body per outcome. Each outcome names its own recovery, and a refusal
  // carries none: asking again returns the same verdict.
  const renderBody = (current: RequestLogsBody): ReactNode => {
    switch (current.kind) {
      case 'loading': {
        return (
          <View className="gap-3 px-6 pt-4">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </View>
        );
      }
      case 'retryable': {
        return (
          <QueryError
            variant={current.variant}
            message={t('organization.requestLogs.loadError')}
            onRetry={() => void logs.refetch()}
            isRetrying={logs.isFetching}
            refreshControl={refreshControl}
          />
        );
      }
      case 'refused': {
        return (
          <QueryError
            variant={current.variant}
            message={t('organization.requestLogs.loadError')}
            refreshControl={refreshControl}
          />
        );
      }
      case 'empty': {
        return (
          <EmptyState
            icon={Logs}
            title={t('organization.requestLogs.emptyTitle')}
            refreshControl={refreshControl}
          />
        );
      }
      case 'list': {
        return (
          <FlashList
            style={listStyle}
            data={current.rows}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            getItemType={() => 'requestLog'}
            ItemSeparatorComponent={RowSeparator}
            contentContainerStyle={listContentContainerStyle}
            refreshControl={refreshControl}
            ListFooterComponent={
              <View className="pt-3">
                {current.truncated ? (
                  <Text variant="muted" className="px-6 text-center text-xs">
                    {t('organization.requestLogs.truncated')}
                  </Text>
                ) : null}
                <View style={{ height: paddingBottom }} pointerEvents="none" />
              </View>
            }
          />
        );
      }
      default: {
        const _exhaustive: never = current;
        return _exhaustive;
      }
    }
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('organization.settingsOnWeb.requestLogs')}
        backFallback={ORGANIZATION_HUB_PATH}
      />
      {/* The window the rows below belong to, and the only filter the phone
          needs: the procedure answers one hour at a time, so moving the window
          is both the time range and the paging. */}
      <View className="gap-2 px-6 pt-4">
        <View className="gap-0.5">
          <Text className="text-sm font-medium text-foreground">
            {formatDate(windowStart, i18n.language, WINDOW_DATE)}
          </Text>
          {/* Each time is isolated on its own, so the AM/PM marker it carries
              stays beside its own clock, and the join is the catalog's, so a
              right-to-left reader gets the pair in that language's order
              instead of one reversed run. */}
          <Text className="text-xs tabular-nums text-muted-foreground">
            {t('common.timeRange', {
              start: isolateLtrBidiText(formatClockTime(windowStart, i18n.language)),
              end: isolateLtrBidiText(formatClockTime(windowEnd, i18n.language)),
            })}
          </Text>
        </View>
        <View className="flex-row gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={!canStepOlder}
            onPress={() => {
              setWindowEndMs(current => current - HOUR_MS);
            }}
            accessibilityLabel={t('organization.requestLogs.older')}
          >
            <DirectionalChevronLeft size={16} color={colors.foreground} />
            <Text>{t('organization.requestLogs.older')}</Text>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={!canStepNewer}
            onPress={() => {
              setWindowEndMs(current => Math.min(current + HOUR_MS, anchorMs));
            }}
            accessibilityLabel={t('organization.requestLogs.newer')}
          >
            <Text>{t('organization.requestLogs.newer')}</Text>
            <DirectionalChevronRight size={16} color={colors.foreground} />
          </Button>
        </View>
      </View>
      {renderBody(body)}
    </View>
  );
}
