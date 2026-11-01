import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { BriefingScorecard } from './briefing-card';
import { BriefingFilterControls } from './briefing-filter-controls';
import { BriefingPeriodLabel } from './briefing-period-label';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  BRIEFING_PATH,
  useBriefingAccess,
  useBriefingDismissals,
  useBriefingInvalidation,
  useBriefingPreferences,
} from '@/lib/agent-briefing';
import { briefingAccessDenied } from '@/lib/agent-briefing-state';
import { useBriefingListFilters } from '@/lib/hooks/use-briefing-list-filters';
import { useManualRefresh } from '@/lib/hooks/use-manual-refresh';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useTRPC } from '@/lib/trpc';

export function BriefingListScreen() {
  const trpc = useTRPC();
  const router = useRouter();
  const { t } = useTranslation();
  const access = useBriefingAccess();
  const offline = useOfflineBannerState();
  const { history, setHistory, organizationId, setOrganizationId } = useBriefingListFilters();
  const memberships = useOrganizationsList();
  const dismissals = useBriefingDismissals();
  const preferences = useBriefingPreferences();
  const noEnabledContexts =
    !history &&
    !briefingAccessDenied(preferences.error) &&
    preferences.data?.contexts
      .filter(item => access.canRead(item.context.organizationId))
      .every(item => !item.enabled);
  let emptyLabel = 'agentBriefing.empty';
  if (history) {
    emptyLabel = 'agentBriefing.emptyHistory';
  } else if (noEnabledContexts) {
    emptyLabel = 'agentBriefing.noEnabledContexts';
  }
  let scope: 'all' | 'personal' | 'organization' = 'organization';
  if (organizationId === undefined) {
    scope = 'all';
  } else if (organizationId === null) {
    scope = 'personal';
  }
  const query = useInfiniteQuery({
    ...trpc.agentBriefing.list.infiniteQueryOptions(
      {
        currentOnly: !history,
        limit: 30,
        scope,
        organizationId: organizationId ?? undefined,
      },
      {
        getNextPageParam: page => page.nextCursor ?? undefined,
      }
    ),
    enabled: access.enabled,
    refetchInterval: history ? false : 30_000,
  });
  const [refreshing, onRefresh] = useManualRefresh(query.refetch, t('common.couldNotRefresh'));
  useBriefingInvalidation(query.error);
  const reports = briefingAccessDenied(query.error)
    ? []
    : (query.data?.pages.flatMap(page => page.reports) ?? []).filter(report =>
        access.canRead(report.context.organizationId)
      );
  const loading = query.isPending && !offline;
  const failure = !loading && query.isError && reports.length === 0;
  // The empty state's own button is the settings entry point while it is on screen,
  // so the header carries the action only in the states that button does not cover.
  const emptySettingsAction =
    noEnabledContexts === true && !loading && !failure && reports.length === 0;
  let footer = <View className="h-8" />;
  if (query.isFetchNextPageError) {
    footer = (
      <Button
        variant="ghost"
        onPress={() => {
          void query.fetchNextPage();
        }}
      >
        <Text>{t('common.retryLoadingMore')}</Text>
      </Button>
    );
  } else if (query.isFetchingNextPage) {
    footer = <Skeleton className="mx-4 h-20 rounded-2xl" />;
  }
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentBriefing.title')}
        showBackButton
        backFallback={'/(app)/(tabs)/(0_home)' as Href}
        headerRight={
          emptySettingsAction ? undefined : (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                router.push(`${BRIEFING_PATH}/settings` as Href);
              }}
            >
              <Text>{t('agentBriefing.settings')}</Text>
            </Button>
          )
        }
      />
      <View className="gap-3 px-4 pb-3">
        <BriefingFilterControls
          history={history}
          onSelectHistory={setHistory}
          organizationId={organizationId}
          organizations={memberships.data?.filter(org => access.canRead(org.organizationId)) ?? []}
          onSelectOrganization={setOrganizationId}
        />
        <Text className="text-xs text-muted-foreground">
          {t(history ? 'agentBriefing.historyHint' : 'agentBriefing.allContexts')}
        </Text>
        {offline || (query.isError && reports.length > 0) ? (
          <Text className="text-xs text-muted-foreground">
            {t(offline ? 'agentBriefing.offline' : 'agentBriefing.cached')}
          </Text>
        ) : null}
      </View>
      {loading && (
        <View className="gap-4 px-4">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </View>
      )}
      {failure && (
        <QueryError
          title={t('agentBriefing.loadError')}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {!loading && !failure && (
        <FlashList
          data={reports}
          keyExtractor={report => report.id}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onEndReached={() => {
            // Once the next page has failed, auto-loading re-fires on every
            // content-size change (the footer grows/shrinks as the fetch flips
            // between loading and error), so the retry footer never settles.
            // Leave recovery to the retry tap until a fetch succeeds.
            if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
              void query.fetchNextPage();
            }
          }}
          renderItem={({ item }) => (
            <Pressable
              className="mx-4 mb-3 overflow-hidden rounded-2xl border border-border bg-card active:opacity-70"
              accessibilityRole="button"
              onPress={() => {
                router.push(`${BRIEFING_PATH}/${item.id}` as Href);
              }}
            >
              <View className="gap-1 px-4 pt-3">
                <Text>
                  {item.context.organizationId === null ? t('common.personal') : item.context.name}
                </Text>
                <BriefingPeriodLabel report={item} />
                {item.dismissedAt || dismissals.data?.some(entry => entry.reportId === item.id) ? (
                  <Text className="text-xs text-muted-foreground">{t('common.dismissed')}</Text>
                ) : null}
              </View>
              <BriefingScorecard report={item} />
            </Pressable>
          )}
          ListEmptyComponent={
            <View className="gap-2 p-8">
              <Text className="text-center">{t(emptyLabel)}</Text>
              {emptySettingsAction ? (
                <Button
                  onPress={() => {
                    router.push(`${BRIEFING_PATH}/settings` as Href);
                  }}
                >
                  <Text>{t('agentBriefing.settings')}</Text>
                </Button>
              ) : (
                <Text className="text-center text-sm text-muted-foreground">
                  {t(history ? 'agentBriefing.historyHint' : 'agentBriefing.emptyHint')}
                </Text>
              )}
            </View>
          }
          ListFooterComponent={footer}
        />
      )}
    </View>
  );
}
