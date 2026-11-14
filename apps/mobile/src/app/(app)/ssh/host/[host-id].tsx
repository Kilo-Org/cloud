import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { HostEditorScreen } from '@/components/ssh/host-editor-screen';
import { parseParam } from '@/lib/route-params';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';

export default function SshHostRoute() {
  const { 'host-id': rawHostId } = useLocalSearchParams<{ 'host-id': string }>();
  const hostId = parseParam(rawHostId);
  if (hostId === null) {
    return <InvalidRouteState backTo={SSH_HOSTS_ROUTE} />;
  }
  return <HostEditorScreen hostId={hostId} />;
}
