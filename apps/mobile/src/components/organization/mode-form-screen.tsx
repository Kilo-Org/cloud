import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { ModeForm } from '@/components/organization/mode-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { SlidersHorizontal } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
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
        <View className="gap-4 px-6 pt-4">
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

function ModeNotFound() {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('agentChat.modePicker.customModes')} />
      <EmptyState
        icon={SlidersHorizontal}
        placement="top"
        title={t('organization.modes.notFound')}
        action={
          <Button
            variant="outline"
            onPress={() => {
              router.replace(MODES_LIST_PATH as Href);
            }}
          >
            <Text>{t('common.back')}</Text>
          </Button>
        }
      />
    </View>
  );
}
