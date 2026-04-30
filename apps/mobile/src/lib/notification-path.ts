import { type PushData } from '@kilocode/notifications';

export function notificationPathForData(data: PushData): string {
  if (data.type === 'chat.message') {
    return `/(app)/chat/${data.sandboxId}/${data.conversationId}`;
  }
  return `/(app)/chat/${data.sandboxId}`;
}
