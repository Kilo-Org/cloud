import { useLocalSearchParams } from 'expo-router';

import { RepoBindingsScreen } from '@/components/profiles/repo-bindings-screen';
import { RootStackProfileScreen } from '@/components/profiles/root-stack-profile-screen';
import { parseParam } from '@/lib/route-params';

export default function AppStackRepoBindingsRoute() {
  const { organizationId: rawOrganizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  return (
    <RootStackProfileScreen>
      <RepoBindingsScreen organizationId={parseParam(rawOrganizationId) ?? undefined} />
    </RootStackProfileScreen>
  );
}
