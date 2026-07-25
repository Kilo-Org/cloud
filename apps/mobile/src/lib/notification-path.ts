import { type PushData } from '@kilocode/notifications';
import { type Href } from 'expo-router';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';
import { getSecurityAgentPath } from './security-agent';

/** String-form `Href` so callers can store the path as a string and still pass it to the router. */
type NotificationHref = Extract<Href, string>;

export function notificationPathForData(data: PushData): NotificationHref {
  // `via=push` marks the resulting session_viewed analytics event as
  // push-originated.
  switch (data.type) {
    case 'cloud_agent_session': {
      return `/(app)/agent-chat/${data.cliSessionId}?via=push` as NotificationHref;
    }
    case 'chat.message': {
      return `${chatConversationRoute(data.sandboxId, data.conversationId)}?via=push` as NotificationHref;
    }
    case 'low_balance': {
      return `/(app)/(tabs)/(3_profile)/organization/credit-activity?org=${data.organizationId}&via=push` as NotificationHref;
    }
    case 'security_finding': {
      // getSecurityAgentPath returns Href; coerce to string for query append (cast style of security-agent.ts).
      const base = getSecurityAgentPath(data.scope, `findings/${data.findingId}`) as string;
      return `${base}?via=push` as NotificationHref;
    }
    case 'instance-lifecycle':
    case 'scheduled-action': {
      return chatSandboxRoute(data.sandboxId) as NotificationHref;
    }
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
