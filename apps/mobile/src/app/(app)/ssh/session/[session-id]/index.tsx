import { useLocalSearchParams } from 'expo-router';

import { SshTerminalScreen } from '@/components/ssh/session/ssh-terminal-screen';
import { parseParam } from '@/lib/route-params';

export default function SshSessionRoute() {
  const { 'session-id': rawSessionId } = useLocalSearchParams<{ 'session-id': string }>();
  return <SshTerminalScreen sessionId={parseParam(rawSessionId) ?? ''} />;
}
