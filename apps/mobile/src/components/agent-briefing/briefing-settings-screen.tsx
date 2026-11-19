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
import { briefingAccessDenied, selectBriefingSettingsPhase } from '@/lib/agent-briefing-state';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';

export function BriefingSettingsScreen() {
  const { t } = useTranslation();
  const access = useBriefingAccess();
  const preferences = useBriefingPreferences();
  const offline = useOfflineBannerState();
  useBriefingInvalidation(preferences.error);
  const phase = selectBriefingSettingsPhase({
    hasPreferences: preferences.data !== undefined,
    offline,
    isPending: preferences.isPending,
    isError: preferences.isError,
    accessDenied: briefingAccessDenied(preferences.error),
  });
  // The ready branch renders from these preferences alone, so its body takes
  // them by name instead of re-checking the query on every field.
  const readyPreferences = phase === 'ready' ? preferences.data : undefined;
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentBriefing.settings')}
        showBackButton
        backFallback={BRIEFING_PATH as Href}
      />
      {readyPreferences !== undefined && (
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerClassName="gap-6 p-4 pb-12">
          {offline ? (
            <Text className="text-xs text-muted-foreground">{t('agentBriefing.offline')}</Text>
          ) : null}
          {/* The keys name the slot, not the saved values: a card that remounts
              when a save lands would drop the text a person is still typing in
              its fields. */}
          <ScheduleSettings key="schedule" preferences={readyPreferences} />
          <BriefingNotificationToggle />
          {readyPreferences.contexts
            .filter(item => access.canRead(item.context.organizationId))
            .map(item => (
              <BriefingContextSettings
                key={`ctx-${item.context.id}`}
                preference={item}
                defaultModel={readyPreferences.defaultModel}
                timezone={readyPreferences.timezone}
              />
            ))}
        </ScrollView>
      )}
      {phase === 'loading' && (
        <View className="p-4">
          <Skeleton className="h-96 rounded-2xl" />
        </View>
      )}
      {/* Connectivity pauses the first fetch instead of failing it, so the screen
          says what it is waiting for and leaves recovery to the reconnect. */}
      {phase === 'offline' && <QueryError variant="offline" title={t('offline.noInternet')} />}
      {/* The server rejected this account's access, which no retry can change. */}
      {phase === 'denied' && <QueryError variant="permission" />}
      {phase === 'failed' && (
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
