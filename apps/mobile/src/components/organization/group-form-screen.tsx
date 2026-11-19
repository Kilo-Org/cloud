import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { type Href, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Lock } from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import { GroupForm } from '@/components/organization/group-form';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { PermissionDenied } from '@/components/organization/permission-denied';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrgGroup } from '@/lib/hooks/use-org-groups-queries';
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
 * Groups are an Enterprise feature (the web page redirects every lower plan),
 * so both paths refuse a lower plan here instead of mounting a form the server
 * would reject. Only an owner or admin may change a group — the mutations are
 * `organizationAdminMutationProcedure` — so a member who reaches the route by a
 * deep link sees the refusal rather than a form the server would reject. The
 * edited group is resolved through `groups.get`, because `groups.list` answers
 * the manager shape to an owner or billing manager only and an admin may still
 * edit the group.
 */
export function OrganizationGroupFormScreen() {
  const { groupId } = useLocalSearchParams<{ groupId?: string }>();
  const { t } = useTranslation();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const enterprise = org?.plan === 'enterprise';
  const canManage = canManageOrganization(role);
  const groupQuery = useOrgGroup(organizationId, groupId ?? null, enterprise && canManage);

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.settingsOnWeb.groups')} />;
  }

  if (!enterprise) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
        <EmptyState
          icon={Lock}
          title={t('organizationModelAccess.enterpriseOnlyTitle')}
          description={t('organization.groups.enterpriseOnly')}
        />
      </View>
    );
  }

  if (!canManage) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
        <PermissionDenied
          description={t('organization.groups.permissionDenied')}
          showBack={false}
        />
      </View>
    );
  }

  if (groupId !== undefined && groupQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('organization.settingsOnWeb.groups')} />
        <View className="gap-3 px-4 pt-3">
          <Skeleton className="h-11 rounded-lg" />
          <Skeleton className="h-20 rounded-lg" />
        </View>
      </View>
    );
  }

  if (groupQuery.isError) {
    const errorView = selectOrgListErrorView(groupQuery.error);
    // `groups.get` answers an unknown or deleted group with NOT_FOUND, so the
    // missing group arrives here, not as an empty success.
    if (errorView.variant === 'not-found') {
      return <GroupNotFound />;
    }
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader
          title={t('organization.settingsOnWeb.groups')}
          backFallback={GROUPS_LIST_PATH as Href}
        />
        <QueryError
          variant={errorView.variant}
          onRetry={errorView.showRetry ? () => void groupQuery.refetch() : undefined}
          isRetrying={groupQuery.isFetching}
        />
      </View>
    );
  }

  const group = groupId === undefined ? undefined : groupQuery.data?.group;

  if (groupId !== undefined && group === undefined) {
    return <GroupNotFound />;
  }

  return <GroupForm key={group?.id ?? 'new'} organizationId={organizationId} group={group} />;
}

/**
 * The shared not-found state. The header owns the one way out, and its
 * fallback lands on the groups list when a deep link left no history to pop.
 */
function GroupNotFound() {
  const { t } = useTranslation();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('organization.settingsOnWeb.groups')}
        backFallback={GROUPS_LIST_PATH as Href}
      />
      <QueryError variant="not-found" message={t('organization.groups.notFound')} />
    </View>
  );
}
