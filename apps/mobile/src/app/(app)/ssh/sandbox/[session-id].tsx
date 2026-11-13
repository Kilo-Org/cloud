import { useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { SandboxTerminalScreen } from '@/components/ssh/session/sandbox-terminal-screen';
import { parseParam } from '@/lib/route-params';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';

export default function SandboxTerminalRoute() {
  const {
    'session-id': rawSessionId,
    organizationId: rawOrganizationId,
    title: rawTitle,
  } = useLocalSearchParams<{
    'session-id': string;
    organizationId?: string;
    title?: string;
  }>();
  const cloudAgentSessionId = parseParam(rawSessionId);
  if (cloudAgentSessionId === null) {
    return <InvalidRouteState backTo={SSH_HOSTS_ROUTE} />;
  }
  const organizationId = parseParam(rawOrganizationId) ?? undefined;
  const title = parseParam(rawTitle);

  return (
    <SandboxTerminalScreen
      cloudAgentSessionId={cloudAgentSessionId}
      {...(organizationId === undefined ? {} : { organizationId })}
      {...(title === null ? {} : { sessionTitle: title })}
    />
  );
}
