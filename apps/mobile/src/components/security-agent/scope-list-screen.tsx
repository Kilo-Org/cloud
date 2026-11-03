import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useQuery } from '@tanstack/react-query';
import { Building2, User } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
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

  const renderOrgSection = () => {
    if (orgsBody.status === 'error') {
      return (
        <QueryError
          placement="top"
          variant={orgsBody.cause === 'offline' ? 'offline' : 'server'}
          title={t('common.couldNotLoadOrganizations')}
          onRetry={() => void refetch()}
          isRetrying={orgsBody.isRetrying}
          className="mt-3"
        />
      );
    }
    if (orgsBody.status === 'loading') {
      return <Skeleton className="mt-3 h-[54px] w-full rounded-lg" />;
    }
    return orgs?.map((org, index) => (
      <ConfigureRow
        key={org.organizationId}
        icon={Building2}
        title={org.organizationName}
        onPress={() => {
          openScope(org.organizationId);
        }}
        last={index === orgs.length - 1}
      />
    ));
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader className="px-6" title={t('common.securityAgent')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        <ConfigureRow
          icon={User}
          title={t('common.personal')}
          subtitle={t('common.yourOwnRepositories')}
          onPress={() => {
            openScope(PERSONAL_SECURITY_SCOPE);
          }}
          last={orgsBody.status === 'empty'}
        />
        {renderOrgSection()}
      </TabScreenScrollView>
    </View>
  );
}
