import { type PushData } from '@kilocode/notifications';
import { type Href } from 'expo-router';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';
import { getSecurityAgentPath } from './security-agent';

/** String-form `Href` so callers can store the path as a string and still pass it to the router. */
type NotificationHref = Extract<Href, string>;

/** Widen string paths built from helpers into the typed-route string union. */
function toNotificationHref(path: string): NotificationHref {
  return path;
}

export function notificationPathForData(data: PushData): NotificationHref {
  // `via=push` marks the resulting session_viewed analytics event as
  // push-originated.
  switch (data.type) {
    case 'cloud_agent_session': {
      return toNotificationHref(`/(app)/agent-chat/${data.cliSessionId}?via=push`);
    }
    case 'chat.message': {
      return toNotificationHref(
        `${chatConversationRoute(data.sandboxId, data.conversationId)}?via=push`
      );
    }
    case 'low_balance': {
      return toNotificationHref(
        `/(app)/(tabs)/(3_profile)/organization/credit-activity?org=${data.organizationId}&via=push`
      );
    }
    case 'security_finding': {
      // getSecurityAgentPath returns Href; coerce to string for query append (cast style of security-agent.ts).
      const base = getSecurityAgentPath(data.scope, `findings/${data.findingId}`) as string;
      return toNotificationHref(`${base}?via=push`);
    }
    case 'instance-lifecycle':
    case 'scheduled-action': {
      return toNotificationHref(chatSandboxRoute(data.sandboxId));
    }
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
