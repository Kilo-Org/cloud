import { type PushData } from '@kilocode/notifications';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';
import { getSecurityAgentPath } from './security-agent';

export function notificationPathForData(data: PushData): string {
  // `via=push` marks the resulting session_viewed analytics event as
  // push-originated.
  switch (data.type) {
    case 'cloud_agent_session': {
      return `/(app)/agent-chat/${data.cliSessionId}?via=push`;
    }
    case 'chat.message': {
      return `${chatConversationRoute(data.sandboxId, data.conversationId)}?via=push`;
    }
    case 'low_balance': {
      return `/(app)/(tabs)/(3_profile)/organization/credit-activity?org=${data.organizationId}&via=push`;
    }
    case 'security_finding': {
      // getSecurityAgentPath returns Href; coerce to string for query append (cast style of security-agent.ts).
      const base = getSecurityAgentPath(data.scope, `findings/${data.findingId}`) as string;
      return `${base}?via=push`;
    }
    case 'instance-lifecycle':
    case 'scheduled-action': {
      return chatSandboxRoute(data.sandboxId);
    }
    default: {
      // Exhaustiveness: new PushData variants must be handled above.
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}
