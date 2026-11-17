import { canManageOrganization } from '@kilocode/app-shared/organizations';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { Plus, Users } from '@/components/ui/icons';

import { EmptyState } from '@/components/empty-state';
import { OrganizationBoundary } from '@/components/organization/organization-boundary';
import { selectOrgListErrorView } from '@/components/organization/org-list-error-view';
import { OrgRecordRow } from '@/components/organization/org-record-row';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { RowGroup } from '@/components/ui/row-group';
import { Section } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { formatNumber } from '@/lib/format';
import { useOrgGroups } from '@/lib/hooks/use-org-groups-queries';
import { useOrgBoundary } from '@/lib/hooks/use-organization-queries';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';

const GROUP_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/group-form' as const;

function GroupsSkeleton() {
  return (
    <Card className="mx-4">
      <Skeleton className="h-4 w-32 rounded bg-muted-soft" />
      <Skeleton className="h-3 w-24 rounded bg-muted-soft" />
    </Card>
  );
}

/**
 * The organization's groups.
 *
 * The web page redirects every plan below Enterprise, so the row and this screen
 * are Enterprise-only. A manager — an owner, admin or billing manager — sees every
 * group and opens one to change it, which the server allows an owner or admin; a
 * plain member sees the groups their own policies come from, read-only. Deleting
 * lives in the group's form, so the list carries no per-row actions.
 */
export function OrganizationGroupsScreen() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const { organizationId, role, org, isResolving } = useOrgBoundary();
  const enterprise = org?.plan === 'enterprise';
  const groupsQuery = useOrgGroups(organizationId, enterprise);
  const canManage = canManageOrganization(role);

  const openGroupForm = (groupId?: string) => {
    router.push({
      pathname: GROUP_FORM_PATH,
      params: groupId === undefined ? {} : { groupId },
    });
  };

  if (isResolving || organizationId == null || org == null) {
    return <OrganizationBoundary title={t('organization.settingsOnWeb.groups')} />;
  }

  const data = groupsQuery.data;
  const managerGroups = data?.access === 'manager' ? data.groups : null;
  const memberGroups = data?.access === 'member' ? data.groups : null;
  const errorView = groupsQuery.isError ? selectOrgListErrorView(groupsQuery.error) : null;

  let body: ReactNode = null;
  if (!enterprise) {
    body = (
      <EmptyState icon={Users} placement="top" title={t('organization.groups.enterpriseOnly')} />
    );
  } else if (groupsQuery.isPending) {
    body = <GroupsSkeleton />;
  } else if (errorView) {
    body = (
      <QueryError
        variant={errorView.variant}
        onRetry={errorView.showRetry ? () => void groupsQuery.refetch() : undefined}
        isRetrying={groupsQuery.isFetching}
      />
    );
  } else if (memberGroups !== null) {
    body = (
      <Section label={t('organization.groups.memberViewTitle')} className="mx-4">
        {memberGroups.length === 0 ? (
          <Text variant="muted">{t('organization.groups.memberViewEmpty')}</Text>
        ) : (
          <RowGroup>
            {memberGroups.map(group => (
              <OrgRecordRow
                key={group.id}
                title={group.name}
                description={group.description ?? undefined}
              />
            ))}
          </RowGroup>
        )}
      </Section>
    );
  } else if (managerGroups === null || managerGroups.length === 0) {
    body = (
      <EmptyState
        icon={Users}
        placement="top"
        title={t('organization.groups.emptyTitle')}
        description={t('organization.groups.emptyDescription')}
        action={
          canManage ? (
            <Button
              className={STATE_ACTION_CLASS}
              onPress={() => {
                openGroupForm();
              }}
            >
              <Text className="text-primary-foreground">{t('organization.groups.create')}</Text>
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <RowGroup className="mx-4">
        {managerGroups.map(group => (
          <OrgRecordRow
            key={group.id}
            title={group.name}
            meta={t('organization.groups.memberCount', {
              count: group.memberIds.length,
              displayCount: formatNumber(group.memberIds.length, i18n.language),
            })}
            description={group.description ?? undefined}
            accessibilityLabel={group.name}
            onPress={
              canManage
                ? () => {
                    openGroupForm(group.id);
                  }
                : undefined
            }
          />
        ))}
      </RowGroup>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={t('organization.settingsOnWeb.groups')}
        headerRight={
          enterprise && canManage ? (
            <IconButton
              accessibilityLabel={t('organization.groups.create')}
              onPress={() => {
                openGroupForm();
              }}
            >
              <Plus size={22} color={colors.foreground} />
            </IconButton>
          ) : undefined
        }
      />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        {body}
      </TabScreenScrollView>
    </View>
  );
}
