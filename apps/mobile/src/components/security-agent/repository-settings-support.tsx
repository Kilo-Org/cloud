import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { i18n } from '@/i18n';

export function repositorySelectionKey(
  repositoryId: number,
  platformIntegrationId: string
): string {
  return `${platformIntegrationId}:${repositoryId}`;
}

type SelectedRepository = {
  repositoryId: number;
  platformIntegrationId: string;
};

export function toggleRepositorySelection(
  current: SelectedRepository[],
  repositoryId: number,
  platformIntegrationId: string
): SelectedRepository[] {
  const key = repositorySelectionKey(repositoryId, platformIntegrationId);
  const selected = current.some(
    selection =>
      repositorySelectionKey(selection.repositoryId, selection.platformIntegrationId) === key
  );
  return selected
    ? current.filter(
        selection =>
          repositorySelectionKey(selection.repositoryId, selection.platformIntegrationId) !== key
      )
    : [...current, { repositoryId, platformIntegrationId }];
}

export function installationStatusLabel(input: {
  active: boolean;
  hasPermissions: boolean;
}): string {
  if (!input.active) {
    return i18n.t('securityAgent.dashboard.syncStatusUnavailable');
  }
  return input.hasPermissions
    ? i18n.t('securityAgent.settingsOverview.enabled')
    : i18n.t('securityAgent.scopeEntry.reauthorizeTitle');
}

export function RepositorySettingsSkeleton() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('securityAgent.repositories.title')} />
      <View className="gap-3 px-6 pt-4">
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-11 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </View>
    </View>
  );
}
