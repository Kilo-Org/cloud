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
import { briefingAccessDenied } from '@/lib/agent-briefing-state';
import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

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
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerClassName={cn(SCREEN_BODY_CLASS, 'pb-12')}
        >
          {offline ? <Text variant="caption">{t('agentBriefing.offline')}</Text> : null}
          <Section>
            <ScheduleSettings
              key={`${available.timezone}:${available.nightStart}:${available.morningStart}:${available.morningEnd}`}
              preferences={available}
            />
          </Section>
          <Section>
            <BriefingNotificationToggle />
          </Section>
          {available.contexts
            .filter(item => access.canRead(item.context.organizationId))
            .map(item => (
              <Section
                key={`${item.context.id}:${item.model}:${item.maxDurationSeconds}:${item.maxSpendMicrodollars}`}
                label={t('agentBriefing.scheduledContextSettings', {
                  context:
                    item.context.organizationId === null ? t('common.personal') : item.context.name,
                })}
              >
                <BriefingContextSettings
                  preference={item}
                  defaultModel={available.defaultModel}
                  timezone={available.timezone}
                />
              </Section>
            ))}
        </ScrollView>
      )}
      {loading && (
        <View className={SCREEN_BODY_CLASS}>
          <Skeleton className="h-96 rounded-xl" />
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
