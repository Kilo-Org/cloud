import { type PushData } from '@kilocode/notifications';

import { chatConversationRoute, chatSandboxRoute } from './kilo-chat-routes';

export function notificationPathForData(data: PushData): string {
  // `via=push` marks the resulting session_viewed analytics event as
  // push-originated.
  if (data.type === 'cloud_agent_session') {
    return `/(app)/agent-chat/${data.cliSessionId}?via=push`;
  }
  if (data.type === 'chat.message') {
    return `${chatConversationRoute(data.sandboxId, data.conversationId)}?via=push`;
  }
  return chatSandboxRoute(data.sandboxId);
}
