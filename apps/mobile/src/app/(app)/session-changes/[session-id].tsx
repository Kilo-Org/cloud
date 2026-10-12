import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SessionChangesScreen } from '@/components/session-changes/session-changes-screen';
import { parseParam } from '@/lib/route-params';

export default function SessionChangesRoute() {
  const { 'session-id': rawSessionId } = useLocalSearchParams<{ 'session-id': string }>();
  const sessionId = parseParam(rawSessionId);
  if (!sessionId) {
    return <InvalidRouteState backTo={'/(app)' as Href} />;
  }
  return <SessionChangesScreen sessionId={sessionId} />;
}
