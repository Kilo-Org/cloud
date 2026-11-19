import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AuditReportButton } from '@/components/security-agent/audit-report-button';
import { ScreenHeader } from '@/components/screen-header';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

/**
 * The Security Agent settings page while its first reads are in flight.
 *
 * It mirrors the settled page instead of three equal cards: one switch row,
 * one helper line, and one `ConfigureRow` whose 30pt icon tile sits beside a
 * title and a subtitle. Group and row keep the loaded screen's geometry, so the
 * body does not reflow when the queries answer.
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
        title={t('securityAgent.dashboard.settings')}
        headerRightWidth={44}
        headerRight={<AuditReportButton scope={scope} />}
      />
      <View className={SCREEN_BODY_CLASS}>
        <RowGroup>
          <RowSkeleton subtitle />
        </RowGroup>
        <View className="gap-3">
          <Skeleton className="h-4 w-56 rounded" />
          <RowGroup>
            <RowSkeleton tile subtitle />
          </RowGroup>
        </View>
      </View>
    </View>
  );
}
