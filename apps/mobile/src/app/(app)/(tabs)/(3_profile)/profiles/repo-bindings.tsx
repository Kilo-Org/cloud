import { useLocalSearchParams } from 'expo-router';

import { RepoBindingsScreen } from '@/components/profiles/repo-bindings-screen';
import { parseParam } from '@/lib/route-params';

export default function RepoBindingsRoute() {
  const { organizationId: rawOrganizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  return <RepoBindingsScreen organizationId={parseParam(rawOrganizationId) ?? undefined} />;
}
