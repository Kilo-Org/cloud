import { type Href } from 'expo-router';
import { Building2, User } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useSinglePushRoute } from '@/lib/hooks/use-single-push-route';
import { QueryError } from '@/components/query-error';
import { ReviewerHeader } from '@/components/code-reviewer/reviewer-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { classifyListBody } from '@/lib/query/list-body-state';

export function ScopeListScreen() {
  const pushOnce = useSinglePushRoute();
  const { t } = useTranslation();
  // The membership read comes through the hook that owns the shared entry's
  // options. A second observer with defaulted options would replace those
  // options while this screen is mounted and leave every other consumer's read
  // paused with no data.
  const { data: orgs, isError, isFetching, fetchStatus, refetch } = useOrganizationsList();
  const connectivity = useCommittedConnectivityStatus();

  const openScope = (scope: string) => {
    pushOnce(`/(app)/code-reviewer/${scope}` as Href);
  };

  // A delivered list stays on screen, so a background refetch that fails over
  // cached rows must not push a banner above them. Only a read that failed with
  // nothing delivered owns the banner, and a failed read names its cause with
  // Retry instead of silently dropping the section.
  const orgsBody = classifyListBody({
    rowCount: orgs?.length ?? 0,
    hasDeliveredData: orgs !== undefined,
    isError,
    isFetching,
    fetchStatus,
    connectivityKnown: connectivity !== 'unknown',
  });

  return (
    <View className="flex-1 bg-background">
      <ReviewerHeader title={t('common.codeReviewer')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName={SCREEN_BODY_CLASS}>
        {orgsBody.status === 'error' ? (
          <QueryError
            // Only a read that delivered nothing reaches here. Its cause picks
            // the icon and wording: a read the connection stopped says so, a
            // read that failed names the organizations it could not answer for.
            variant={orgsBody.cause === 'offline' ? 'offline' : 'server'}
            title={t('common.couldNotLoadOrganizations')}
            message={t('codeReviewer.scopeList.personalStillAvailable')}
            placement="top"
            className="pb-6 pt-0"
            onRetry={() => void refetch()}
            isRetrying={orgsBody.isRetrying}
          />
        ) : null}
        <RowGroup leadingTile>
          <ConfigureRow
            icon={User}
            title={t('common.personal')}
            subtitle={t('common.yourOwnRepositories')}
            onPress={() => {
              openScope(PERSONAL_SCOPE);
            }}
          />
          {/* The placeholder joins the group the organizations land in, so the
              rows replace it in place. A read that never delivered is the
              placeholder's surface; one that failed with nothing delivered is
              the banner's, not a placeholder that never resolves. */}
          {orgsBody.status === 'loading' ? <RowSkeleton tile subtitle /> : null}
          {orgs?.map(org => (
            <ConfigureRow
              key={org.organizationId}
              icon={Building2}
              title={org.organizationName}
              // Every scope row says what it covers, as Personal does; a
              // member's row says instead that the scope is read-only.
              subtitle={
                org.role === 'member'
                  ? t('codeReviewer.scopeList.viewOnly')
                  : t('common.organizationRepositories')
              }
              onPress={() => {
                openScope(org.organizationId);
              }}
            />
          ))}
        </RowGroup>
      </TabScreenScrollView>
    </View>
  );
}
