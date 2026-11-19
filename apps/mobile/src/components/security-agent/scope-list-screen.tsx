import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useQuery } from '@tanstack/react-query';
import { Building2, User } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { classifyListBody } from '@/lib/query/list-body-state';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

// Diverges from the Code Reviewer scope list: current server policy allows
// org members to operate Security Agent, so members are not labeled "View only".
export function ScopeListScreen() {
  const pushOnce = useSinglePushRoute();
  const trpc = useTRPC();
  const { t } = useTranslation();
  const {
    data: orgs,
    isError,
    isFetching,
    fetchStatus,
    refetch,
  } = useQuery(trpc.organizations.list.queryOptions());
  const connectivityKnown = useCommittedConnectivityStatus() !== 'unknown';

  const openScope = (scope: string) => {
    pushOnce(getSecurityAgentPath(scope));
  };

  // An org-list failure only degrades the organization section — the
  // Personal scope doesn't depend on it and must stay reachable. Only a
  // delivered read may say which organizations exist: a failed read, or one
  // paused by lost connectivity, delivered nothing and names its cause with
  // Retry instead of silently dropping the section.
  const orgsBody = classifyListBody({
    rowCount: orgs?.length ?? 0,
    hasDeliveredData: orgs !== undefined,
    isError: isError && orgs === undefined,
    isFetching,
    fetchStatus,
    connectivityKnown,
  });

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.securityAgent')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
        <RowGroup leadingTile>
          <ConfigureRow
            icon={User}
            title={t('common.personal')}
            subtitle={t('common.yourOwnRepositories')}
            onPress={() => {
              openScope(PERSONAL_SECURITY_SCOPE);
            }}
          />
          {orgsBody.status === 'rows'
            ? orgs?.map(org => (
                <ConfigureRow
                  key={org.organizationId}
                  icon={Building2}
                  title={org.organizationName}
                  onPress={() => {
                    openScope(org.organizationId);
                  }}
                />
              ))
            : null}
          {/* The organization placeholders join the group the organizations
              land in, so the rows replace them inside one surface instead of
              a second card appearing and disappearing below it. */}
          {orgsBody.status === 'loading'
            ? [0, 1].map(index => <RowSkeleton key={index} tile />)
            : null}
        </RowGroup>

        {orgsBody.status === 'error' ? (
          <QueryError
            placement="top"
            variant={orgsBody.cause === 'offline' ? 'offline' : 'server'}
            title={t('common.couldNotLoadOrganizations')}
            onRetry={() => void refetch()}
            isRetrying={orgsBody.isRetrying}
          />
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
