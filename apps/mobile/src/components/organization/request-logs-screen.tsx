import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type ViewStyle } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { RequestLogsSkeleton } from '@/components/organization/request-logs-skeleton';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DirectionalArrowLeft, DirectionalArrowRight, DirectionalLogs } from '@/components/ui/directional-icons';
import { RefreshControl } from '@/components/ui/refresh-control';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { isolateBidiText } from '@/lib/bidi';
import {
  formatClockTime,
  formatDate,
  formatNumber,
  formatPrefixedUsd,
  UNMEASURED_VALUE,
} from '@/lib/format';
import { type OrgRequestLogEntry, useOrgRequestLogs } from '@/lib/hooks/use-org-billing-queries';
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

// The cards carry the page gutter themselves. The tab bar's own bottom padding
// rides on the footer, which `gap` would not cover, and the body's top pad sits
// on a header component because a FlashList cannot take a class on its content
// container.
const listStyle = { flex: 1 } satisfies ViewStyle;

const ListTopPad = () => <View className="pt-3" />;

const WINDOW_DATE = { weekday: 'short', month: 'short', day: 'numeric' } as const;

const RowSeparator = () => <View className="h-3" />;

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
    <Card className="mx-4">
      <View className="flex-row items-baseline gap-3">
        <Text variant="mono" className="flex-1" numberOfLines={1}>
          {entry.model ?? UNMEASURED_VALUE}
        </Text>
        <Text className="shrink-0 text-sm font-medium tabular-nums text-foreground">{cost}</Text>
      </View>
      <View className="flex-row items-center gap-3">
        <Text variant="caption" className="flex-1" numberOfLines={1}>
          {userName}
        </Text>
        <Text variant="caption" className="shrink-0" numberOfLines={1}>
          {entry.provider ?? UNMEASURED_VALUE}
        </Text>
      </View>
      <View className="flex-row items-center gap-2">
        {/* One run, so the time and the token pair keep the catalog's own
            separators: a `gap` between two `Text`s spaced the first dot
            differently from the dot inside `in · out`. The time is isolated on
            its own so the AM/PM marker stays beside its clock in either
            direction. */}
        <Text variant="caption" className="flex-1 tabular-nums" numberOfLines={1}>
          {`${isolateBidiText(time)} · ${tokens}`}
        </Text>
        {entry.is_user_byok ? (
          // Muted text with no box: `bg-muted` is the card's own `bg-secondary`
          // in both themes, so a filled badge paints nothing, and its padding
          // pulled the marker inside the right edge that cost and provider
          // share while adding a line of height the other rows lack.
          <Text variant="caption" className="shrink-0">
            {t('organization.requestLogs.byok')}
          </Text>
        ) : null}
      </View>
    </Card>
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
        return <RequestLogsSkeleton />;
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
            icon={DirectionalLogs}
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
            ListHeaderComponent={<ListTopPad />}
            refreshControl={refreshControl}
            ListFooterComponent={
              <View className="pt-3">
                {current.truncated ? (
                  <Text variant="caption" className="px-4 text-center">
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
          is both the time range and the paging. The hint states the window's
          one rule in place, and it never changes, so no row moves when a
          window loads. */}
      <View className="gap-2 px-4 pt-3">
        <View className="gap-0.5">
          <Text className="text-sm font-medium text-foreground">
            {formatDate(windowStart, i18n.language, WINDOW_DATE)}
          </Text>
          {/* Each time is isolated on its own, so the AM/PM marker it carries
              stays beside its own clock, and the join is the catalog's, so a
              right-to-left reader gets the pair in that language's order
              instead of one reversed run. */}
          <Text variant="caption" className="tabular-nums">
            {t('common.timeRange', {
              start: isolateBidiText(formatClockTime(windowStart, i18n.language)),
              end: isolateBidiText(formatClockTime(windowEnd, i18n.language)),
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
            <DirectionalArrowLeft size={16} className="text-foreground" />
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
            <DirectionalArrowRight size={16} className="text-foreground" />
          </Button>
        </View>
      </View>
      {renderBody(body)}
    </View>
  );
}
