import { useInfiniteQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { formatBriefingTimestamp } from './briefing-window';
import { QueryError } from '@/components/query-error';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { BRIEFING_PATH, useBriefingAccess } from '@/lib/agent-briefing';
import { briefingAccessDenied } from '@/lib/agent-briefing-state';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

export function BriefingDrafts() {
  const trpc = useTRPC();
  const router = useRouter();
  const access = useBriefingAccess();
  const offline = useOfflineBannerState();
  const { t, i18n } = useTranslation();
  const query = useInfiniteQuery({
    ...trpc.agentBriefing.oneOffDrafts.infiniteQueryOptions(
      { limit: 20 },
      { getNextPageParam: page => page.nextCursor ?? undefined }
    ),
    enabled: access.enabled,
    refetchInterval: 5000,
  });
  const drafts = briefingAccessDenied(query.error)
    ? []
    : (query.data?.pages.flatMap(page => page.drafts) ?? []).filter(draft =>
        access.canRead(draft.context.organizationId)
      );
  if (query.isPending && !offline) {
    return <Skeleton className="h-24 rounded-2xl" />;
  }
  if (query.isError && drafts.length === 0) {
    return (
      <QueryError
        title={t('agentBriefing.loadError')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (drafts.length === 0) {
    return null;
  }
  return (
    <View className="gap-3">
      <Text className="font-semibold">{t('agentBriefing.preparationDrafts')}</Text>
      {drafts.map(draft => (
        <View key={draft.id} className="gap-2 rounded-2xl border border-border bg-card p-4">
          <Text>
            {draft.context.organizationId === null ? t('common.personal') : draft.context.name}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('agentBriefing.window', {
              start: formatBriefingTimestamp(draft.startAt, i18n.language, draft.timezone),
              end: formatBriefingTimestamp(draft.endAt, i18n.language, draft.timezone),
            })}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t(
              {
                failed: 'agentBriefing.preparationFailed',
                ready: 'agentBriefing.reviewBriefing',
                pending: 'agentBriefing.preparing',
                running: 'agentBriefing.preparing',
              }[draft.status]
            )}
          </Text>
          <Button
            variant="outline"
            onPress={() => {
              router.push(`${BRIEFING_PATH}/prepare/${draft.id}` as Href);
            }}
          >
            <Text>{t('agentBriefing.resumeReview')}</Text>
          </Button>
        </View>
      ))}
      {query.hasNextPage || query.isFetchNextPageError ? (
        <Button
          variant="ghost"
          disabled={query.isFetchingNextPage || offline}
          loading={query.isFetchingNextPage}
          onPress={() => {
            void query.fetchNextPage();
          }}
        >
          <Text>
            {t(query.isFetchNextPageError ? 'common.retryLoadingMore' : 'common.loadMore')}
          </Text>
        </Button>
      ) : null}
    </View>
  );
}
