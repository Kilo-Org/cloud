import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Building2, User } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useTRPC } from '@/lib/trpc';

// Diverges from the Code Reviewer scope list: current server policy allows
// org members to operate Security Agent, so members are not labeled "View only".
export function ScopeListScreen() {
  const router = useRouter();
  const trpc = useTRPC();
  const { data: orgs, isLoading } = useQuery(trpc.organizations.list.queryOptions());

  const openScope = (scope: string) => {
    router.push(getSecurityAgentPath(scope));
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Security Agent" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-24">
        <ConfigureRow
          icon={User}
          title="Personal"
          subtitle="Your own repositories"
          onPress={() => {
            openScope(PERSONAL_SECURITY_SCOPE);
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
              onPress={() => {
                openScope(org.organizationId);
              }}
              last={index === orgs.length - 1}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}
