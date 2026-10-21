import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { BriefingContextSettings } from './briefing-context-settings';
import { BriefingNotificationToggle } from './briefing-notification-toggle';
import { ScheduleSettings } from './briefing-schedule-settings';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  BRIEFING_PATH,
  useBriefingAccess,
  useBriefingInvalidation,
  useBriefingPreferences,
} from '@/lib/agent-briefing';
import { briefingAccessDenied } from '@/lib/agent-briefing-state';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';

export function BriefingSettingsScreen() {
  const { t } = useTranslation();
  const access = useBriefingAccess();
  const preferences = useBriefingPreferences();
  const offline = useOfflineBannerState();
  useBriefingInvalidation(preferences.error);
  const available = briefingAccessDenied(preferences.error) ? undefined : preferences.data;
  const loading = !available && preferences.isPending && !offline;
  const failure = !available && !loading;
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentBriefing.settings')}
        showBackButton
        backFallback={BRIEFING_PATH as Href}
      />
      {available && (
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerClassName="gap-6 p-4 pb-12">
          {offline ? (
            <Text className="text-xs text-muted-foreground">{t('agentBriefing.offline')}</Text>
          ) : null}
          <ScheduleSettings
            key={`${available.timezone}:${available.nightStart}:${available.morningStart}:${available.morningEnd}`}
            preferences={available}
          />
          <BriefingNotificationToggle />
          {available.contexts
            .filter(item => access.canRead(item.context.organizationId))
            .map(item => (
              <BriefingContextSettings
                key={`${item.context.id}:${item.model}:${item.maxDurationSeconds}:${item.maxSpendMicrodollars}`}
                preference={item}
                defaultModel={available.defaultModel}
              />
            ))}
        </ScrollView>
      )}
      {loading && (
        <View className="p-4">
          <Skeleton className="h-96 rounded-2xl" />
        </View>
      )}
      {failure && (
        <QueryError
          title={t('agentBriefing.loadError')}
          onRetry={() => {
            void preferences.refetch();
          }}
        />
      )}
    </View>
  );
}
