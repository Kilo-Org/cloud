import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { Building2, User } from '@/components/ui/icons';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { classifyListBody } from '@/lib/query/list-body-state';
import { classifyReadFailureVariant } from '@/lib/query/read-failure-variant';
import { getSecurityAgentPath } from '@/lib/security-agent';

// Diverges from the Code Reviewer scope list: current server policy allows
// org members to operate Security Agent, so members are not labeled "View only".
export function ScopeListScreen() {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  // The membership read comes through the hook that owns the shared entry's
  // options. A second observer with defaulted options would replace those
  // options while this screen is mounted and leave every other consumer's read
  // paused with no data.
  const { data: orgs, error, isError, isFetching, fetchStatus, refetch } = useOrganizationsList();
  const connectivity = useCommittedConnectivityStatus();

  const openScope = (scope: string) => {
    pushOnce(getSecurityAgentPath(scope));
  };

  // An org-list failure only degrades the organization section — the
  // Personal scope doesn't depend on it and must stay reachable. Only a
  // delivered read may say which organizations exist, so a failed read names
  // its cause with Retry instead of silently dropping the section.
  const orgsBody = classifyListBody({
    rowCount: orgs?.length ?? 0,
    hasDeliveredData: orgs !== undefined,
    isError: isError && orgs === undefined,
    isFetching,
    fetchStatus,
    connectivityKnown: connectivity !== 'unknown',
  });
  // The read settles instead of pausing, so `classifyListBody` can no longer
  // reach its paused cause here: the failure's own cause decides the copy. A
  // failure that never reached the server is the connection's.
  const failureVariant = classifyReadFailureVariant({
    errors: error ? [error] : [],
    isPaused: false,
    connectivity,
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
                  // Every scope row says what it covers, as Personal does.
                  subtitle={t('common.organizationRepositories')}
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
            ? [0, 1].map(index => <RowSkeleton key={index} tile subtitle />)
            : null}
        </RowGroup>

        {orgsBody.status === 'error' ? (
          <QueryError
            placement="top"
            variant={failureVariant}
            title={t('common.couldNotLoadOrganizations')}
            onRetry={() => void refetch()}
            isRetrying={orgsBody.isRetrying}
          />
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
