import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { BriefingContextSettings } from './briefing-context-settings';
import { BriefingNotificationToggle } from './briefing-notification-toggle';
import { ScheduleSettings } from './briefing-schedule-settings';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Section } from '@/components/ui/section';
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
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

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
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-12')}
        >
          {offline ? <Text variant="caption">{t('agentBriefing.offline')}</Text> : null}
          {/* The keys name the slot, not the saved values: a card that remounts
              when a save lands would drop the text a person is still typing in
              its fields. */}
          <Section>
            <ScheduleSettings key="schedule" preferences={readyPreferences} />
          </Section>
          <Section>
            <BriefingNotificationToggle />
          </Section>
          {readyPreferences.contexts
            .filter(item => access.canRead(item.context.organizationId))
            .map(item => (
              <Section
                key={`ctx-${item.context.id}`}
                label={t('agentBriefing.scheduledContextSettings', {
                  context:
                    item.context.organizationId === null ? t('common.personal') : item.context.name,
                })}
              >
                <BriefingContextSettings
                  preference={item}
                  defaultModel={readyPreferences.defaultModel}
                  timezone={readyPreferences.timezone}
                />
              </Section>
            ))}
        </ScrollView>
      )}
      {phase === 'loading' && (
        <View className={SCREEN_BODY_CLASS}>
          <Skeleton className="h-96 rounded-xl" />
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
