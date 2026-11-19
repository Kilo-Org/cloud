import { type Href, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ModeForm } from '@/components/organization/mode-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrgModes } from '@/lib/hooks/use-org-modes-queries';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

const MODES_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/modes';

/**
 * The organization mode route: it resolves the mode the request names and hands a
 * record that already exists to the form, so the fields seed once and a list
 * refetch cannot overwrite typed text. A create request resolves no mode and
 * mounts the form empty.
 */
export function OrganizationModeFormScreen() {
  const { modeId } = useLocalSearchParams<{ modeId?: string }>();
  const { t } = useTranslation();
  const { organizationId, org, isResolving } = useOrgBoundary();
  const modesQuery = useOrgModes(organizationId);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('agentChat.modePicker.customModes')} />;
  }

  if (modeId !== undefined && modesQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('agentChat.modePicker.customModes')} />
        <View className="gap-3 px-4 pt-3">
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </View>
      </View>
    );
  }

  if (modesQuery.isError) {
    const errorView = selectOrgListErrorView(modesQuery.error);
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('agentChat.modePicker.customModes')} />
        <QueryError
          variant={errorView.variant}
          inset="gutter"
          onRetry={errorView.showRetry ? () => void modesQuery.refetch() : undefined}
          isRetrying={modesQuery.isFetching}
        />
      </View>
    );
  }

  const mode = modeId === undefined ? undefined : modesQuery.data?.modes.find(m => m.id === modeId);
  if (modeId !== undefined && mode === undefined) {
    return <ModeNotFound />;
  }

  return (
    <ModeForm
      key={mode?.id ?? 'new'}
      organizationId={organizationId}
      mode={mode}
      existingModes={modesQuery.data?.modes ?? []}
    />
  );
}

/**
 * The shared not-found state. The header owns the one way out, and its
 * fallback lands on the modes list when a deep link left no history to pop.
 */
function ModeNotFound() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('agentChat.modePicker.customModes')}
        backFallback={MODES_LIST_PATH as Href}
      />
      <QueryError variant="not-found" message={t('organization.modes.notFound')} />
    </View>
  );
}
