import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { BriefingCreateReview } from './briefing-create-review';
import { formatBriefingTimestamp } from './briefing-window';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { BRIEFING_PATH, useBriefingAccess } from '@/lib/agent-briefing';
import { useCreateBriefing } from '@/lib/hooks/use-create-briefing';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';

export function BriefingPreparationScreen() {
  const { 'report-id': reportId } = useLocalSearchParams<{ 'report-id': string }>();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const creation = useCreateBriefing(reportId);
  const access = useBriefingAccess();
  const offline = useOfflineBannerState();
  const draft = creation.draft;
  const denied = draft !== null && !access.canRead(draft.context.organizationId);
  useEffect(() => {
    const report = creation.prepared?.report;
    if (report?.publishedAt && !denied) {
      router.replace(`${BRIEFING_PATH}/${report.id}` as Href);
    }
  }, [creation.prepared, denied, router]);
  const confirm = async () => {
    if (offline || denied) {
      return;
    }
    const report = await creation.create();
    if (report) {
      router.replace(`${BRIEFING_PATH}/${report.id}` as Href);
    }
  };
  const renderStatus = () => {
    if (!draft) {
      return null;
    }
    if (creation.prepared) {
      return (
        <BriefingCreateReview
          prepared={creation.prepared}
          disabled={offline || creation.preparing || creation.creating}
          creating={creation.creating}
          onCreate={() => {
            void confirm();
          }}
          onReviewAgain={() => {
            void creation.refresh();
          }}
        />
      );
    }
    if (draft.status === 'failed') {
      return (
        <View className="gap-3">
          <Text className="text-destructive">
            {t(
              draft.error === 'time_limit'
                ? 'agentBriefing.preparationTimedOut'
                : 'agentBriefing.preparationFailed'
            )}
          </Text>
          <Button
            disabled={offline || creation.preparing}
            loading={creation.preparing}
            onPress={() => {
              void creation.retryPreparation();
            }}
          >
            <Text>{t('common.retry')}</Text>
          </Button>
        </View>
      );
    }
    if (draft.status === 'ready' && creation.error) {
      return (
        <QueryError
          title={t('agentBriefing.reviewFailed')}
          onRetry={() => {
            void creation.refresh();
          }}
        />
      );
    }
    return (
      <View
        className="gap-3 rounded-2xl border border-border bg-card p-4"
        accessibilityLiveRegion="polite"
      >
        <View className="flex-row items-center gap-2">
          <ActivityIndicator />
          <Text className="font-semibold">{t('agentBriefing.preparing')}</Text>
        </View>
        <Text className="text-sm text-muted-foreground">{t('agentBriefing.preparationHint')}</Text>
        {creation.error ? (
          <QueryError
            title={t('agentBriefing.reviewFailed')}
            onRetry={() => {
              void creation.refresh();
            }}
          />
        ) : null}
      </View>
    );
  };
  const renderBody = () => {
    if (creation.loading && !offline) {
      return <Skeleton className="h-48 rounded-2xl" />;
    }
    if (denied) {
      return <Text className="text-destructive">{t('common.accessDenied')}</Text>;
    }
    if (!draft) {
      return (
        <QueryError
          title={t('agentBriefing.loadError')}
          onRetry={() => {
            void creation.refresh();
          }}
        />
      );
    }
    return (
      <>
        <Text className="font-semibold">
          {draft.context.organizationId === null ? t('common.personal') : draft.context.name}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {t('agentBriefing.window', {
            start: formatBriefingTimestamp(draft.startAt, i18n.language, draft.timezone),
            end: formatBriefingTimestamp(draft.endAt, i18n.language, draft.timezone),
          })}
        </Text>
        <Text className="text-xs text-muted-foreground">{draft.timezone}</Text>
        {renderStatus()}
      </>
    );
  };
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentBriefing.reviewBriefing')}
        showBackButton
        backFallback={`${BRIEFING_PATH}/create` as Href}
      />
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerClassName="gap-4 p-4 pb-12">
        {renderBody()}
        <View className="min-h-[20px]">
          {offline || creation.error ? (
            <Text className="text-sm text-destructive">
              {offline ? t('agentBriefing.createOffline') : creation.error}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
