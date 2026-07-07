import { useQuery } from '@tanstack/react-query';
import { type Href, useRouter } from 'expo-router';
import { Building2, User } from 'lucide-react-native';
import { ScrollView, View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { Skeleton } from '@/components/ui/skeleton';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import { useTRPC } from '@/lib/trpc';

export function ScopeListScreen() {
  const router = useRouter();
  const trpc = useTRPC();
  const { data: orgs, isLoading } = useQuery(trpc.organizations.list.queryOptions());

  const openScope = (scope: string) => {
    router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}` as Href);
  };

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title="Code Reviewer" />
      <ScrollView className="flex-1 px-6" contentContainerClassName="pt-4 pb-8">
        <ConfigureRow
          icon={User}
          title="Personal"
          subtitle="Your own repositories"
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
              subtitle={org.role === 'member' ? 'View only' : undefined}
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
