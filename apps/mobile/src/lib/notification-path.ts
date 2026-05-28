import { type PushData } from '@kilocode/notifications';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';

export function notificationPathForData(data: PushData): string {
  if (data.type === 'cloud_agent_session') {
    return `/(app)/agent-chat/${data.cliSessionId}`;
  }
  if (data.type === 'chat.message') {
    return chatConversationRoute(data.sandboxId, data.conversationId);
  }
  return chatSandboxRoute(data.sandboxId);
}
