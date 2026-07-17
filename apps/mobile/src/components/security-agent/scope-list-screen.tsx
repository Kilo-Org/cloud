import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Building2, User } from 'lucide-react-native';
import { View } from 'react-native';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { TabScreenScrollView } from '@/components/tab-screen';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

// Diverges from the Code Reviewer scope list: current server policy allows
// org members to operate Security Agent, so members are not labeled "View only".
export function ScopeListScreen() {
  const router = useRouter();
  const trpc = useTRPC();
  const {
    data: orgs,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery(trpc.organizations.list.queryOptions());

  const openScope = (scope: string) => {
    router.push(getSecurityAgentPath(scope));
  };

  // An org-list failure only degrades the organization section — the
  // Personal scope doesn't depend on it and must stay reachable.
  const showOrgsError = isError && !orgs;

  const renderOrgSection = () => {
    if (showOrgsError) {
      return (
        <QueryError
          placement="top"
          variant="server"
          title="Could not load organizations"
          onRetry={() => void refetch()}
          isRetrying={isFetching}
          className="mt-3"
        />
      );
    }
    if (isLoading) {
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
      <ScreenHeader title="Security Agent" />
      <TabScreenScrollView className="flex-1 px-6" contentContainerClassName="pt-4">
        <ConfigureRow
          icon={User}
          title="Personal"
          subtitle="Your own repositories"
          onPress={() => {
            openScope(PERSONAL_SECURITY_SCOPE);
          }}
          last={!isLoading && !showOrgsError && (orgs?.length ?? 0) === 0}
        />
        {renderOrgSection()}
      </TabScreenScrollView>
    </View>
  );
}
