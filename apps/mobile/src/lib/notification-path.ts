import { type PushData } from '@kilocode/notifications';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';

export function notificationPathForData(data: PushData): string {
  if (data.type === 'chat.message') {
    return chatConversationRoute(data.sandboxId, data.conversationId);
  }
  return chatSandboxRoute(data.sandboxId);
}
