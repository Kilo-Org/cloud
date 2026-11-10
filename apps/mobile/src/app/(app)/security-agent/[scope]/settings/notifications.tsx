import {
  InvalidSecurityScopeRoute,
  useSecurityAgentScope,
} from '@/components/security-agent/security-agent-scope-route';
import { NotificationSettingsScreen } from '@/components/security-agent/notification-settings-screen';

export default function SecurityAgentNotificationSettingsRoute() {
  const scope = useSecurityAgentScope();

  if (!scope) {
    return <InvalidSecurityScopeRoute />;
  }

  return <NotificationSettingsScreen scope={scope} />;
}
