import { useLocalSearchParams } from 'expo-router';

import { SshPromptSheet } from '@/components/ssh/session/ssh-prompt-sheet';
import { parseParam } from '@/lib/route-params';

export default function SshPromptRoute() {
  const { 'session-id': rawSessionId } = useLocalSearchParams<{ 'session-id': string }>();
  return <SshPromptSheet sessionId={parseParam(rawSessionId) ?? ''} />;
}
