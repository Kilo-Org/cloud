import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The Security Agent settings page while its first reads are in flight.
 *
 * It mirrors the settled page instead of three equal cards: one switch card,
 * one helper line, and one configure row whose 30dp icon tile sits beside a
 * title and a subtitle. Card, line and row keep the loaded screen's geometry,
 * so the body does not reflow when the queries answer.
 *
 * The header action belongs to the header, not to the loaded body: a ⋯ that
 * appeared only after the queries answered changed the header between the two
 * states. The audit report screen renders its own permission state for a
 * caller who cannot manage the scope.
 */
export function SettingsOverviewSkeleton({ scope }: Readonly<{ scope: string }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        className="px-6"
        title={t('securityAgent.dashboard.settings')}
        headerRightWidth={44}
        headerRight={<AuditReportButton scope={scope} />}
      />
      <View className="gap-6 px-6 py-4">
        <Skeleton className="h-16 w-full rounded-lg" />
        <View className="gap-3">
          <Skeleton className="h-4 w-56 rounded" />
          <View className="flex-row items-center gap-3 py-3">
            <Skeleton className="h-[30px] w-[30px] rounded-lg" />
            <View className="flex-1">
              <Skeleton className="h-5 w-40 rounded" />
              <Skeleton className="mt-0.5 h-4 w-56 rounded" />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
