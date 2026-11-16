import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Users } from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import { GroupForm } from '@/components/organization/group-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useOrgGroups } from '@/lib/hooks/use-org-groups-queries';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';

const GROUPS_LIST_PATH = '/(app)/(tabs)/(3_profile)/organization/groups';
/**
 * One organization group, created or edited.
 *
 * A create carries the name and description, which is all the create procedure
 * takes; the members belong to the record that exists, so the form offers them
 * once the group is saved and opens the new group for exactly that step. An edit
 * saves the metadata together with the member selection, which is the one
 * `updateDetails` call the web panel makes.
 *
 * Only an owner or admin may change a group — the mutations are
 * `organizationAdminMutationProcedure` — so a member who reaches the route by a
 * deep link sees the refusal rather than a form the server would reject.
 */
export function OrganizationGroupFormScreen() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const enterprise = org?.plan === 'enterprise';
  const groupsQuery = useOrgGroups(organizationId, enterprise);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.settingsOnWeb.groups')} />;
  }

  if (groupId !== undefined && groupsQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
        <View className="gap-4 px-6 pt-4">
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </View>
      </View>
    );
  }

  if (groupsQuery.isError) {
    const errorView = selectOrgListErrorView(groupsQuery.error);
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
        <QueryError
          variant={errorView.variant}
          onRetry={errorView.showRetry ? () => void groupsQuery.refetch() : undefined}
          isRetrying={groupsQuery.isFetching}
        />
      </View>
    );
  }

  if (!canManageOrganization(role)) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
        <PermissionDenied description={t('organization.groups.permissionDenied')} />
      </View>
    );
  }

  const data = groupsQuery.data;
  const group =
    groupId === undefined || data?.access !== 'manager'
      ? undefined
      : data.groups.find(candidate => candidate.id === groupId);

  if (groupId !== undefined && group === undefined) {
    return <GroupNotFound />;
  }

  return <GroupForm key={group?.id ?? 'new'} organizationId={organizationId} group={group} />;
}

function GroupNotFound() {
  const router = useRouter();
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
      <EmptyState
        icon={Users}
        placement="top"
        title={t('organization.groups.notFound')}
        action={
          <Button
            variant="outline"
            onPress={() => {
              router.replace(GROUPS_LIST_PATH as Href);
            }}
          >
            <Text>{t('common.back')}</Text>
          </Button>
        }
      />
    </View>
  );
}
