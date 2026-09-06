import { useQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { Building2, User } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useTRPC } from '@/lib/trpc';

export function ScopeListScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const trpc = useTRPC();
  const {
    data: orgs,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery(trpc.organizations.list.queryOptions());

  const openScope = (scope: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}` as Href);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('common.codeReviewer')} />
      <TabScreenScrollView className="flex-1" contentContainerClassName="px-6 pt-4">
        {isError && (
          <QueryError
            variant="server"
            title={t(
              // i18n-dup-ok: 'common.couldNotLoadOrganizations' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
              'common.couldNotLoadOrganizations'
            )}
            message={t('codeReviewer.scopeList.personalStillAvailable')}
            placement="top"
            className="pb-6 pt-0"
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        )}
        <ConfigureRow
          icon={User}
          title={t('common.personal')}
          subtitle={t(
            // i18n-dup-ok: 'common.yourOwnRepositories' — sole key for this copy; the base-catalog twin this scan cites was removed by the catalog consolidation
            'common.yourOwnRepositories'
          )}
          onPress={() => {
            openScope(PERSONAL_SCOPE);
          }}
          last={!isLoading && (orgs?.length ?? 0) === 0}
        />
        {isLoading ? (
          <Skeleton className="mt-3 h-[54px] w-full rounded-lg" />
        ) : (
          orgs?.map((org, index) => (
            <ConfigureRow
              key={org.organizationId}
              icon={Building2}
              title={org.organizationName}
              subtitle={org.role === 'member' ? t('codeReviewer.scopeList.viewOnly') : undefined}
              onPress={() => {
                openScope(org.organizationId);
              }}
              last={index === orgs.length - 1}
            />
          ))
        )}
      </TabScreenScrollView>
    </View>
  );
}
