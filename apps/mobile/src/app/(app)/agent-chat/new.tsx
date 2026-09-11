import { useLocalSearchParams } from 'expo-router';

import { NewSessionScreenBody } from '@/components/agents/new-session-screen-body';
import { NewSessionModelProvider } from '@/components/agents/new-session-model-provider';

export default function NewSessionScreen() {
  const { connectionId, organizationId } = useLocalSearchParams<{
    connectionId?: string;
    organizationId?: string;
  }>();
  return (
    <NewSessionModelProvider organizationId={organizationId}>
      <NewSessionScreenBody initialConnectionId={connectionId} />
    </NewSessionModelProvider>
  );
}
