import { useLocalSearchParams } from 'expo-router';

import { NewSessionRoute } from '@/components/agents/new-session-route';

export default function NewSessionScreen() {
  const { organizationId } = useLocalSearchParams<{
    organizationId?: string;
  }>();
  return <NewSessionRoute organizationId={organizationId} />;
}
