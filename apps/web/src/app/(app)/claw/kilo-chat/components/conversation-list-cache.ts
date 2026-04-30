import { kiloclawInstanceContext } from '@kilocode/event-service';
import { conversationsKey } from '@kilocode/kilo-chat-hooks';

export function conversationListQueryKeyForInstanceEvent(ctx: string, sandboxId: string | null) {
  if (!sandboxId) return null;
  if (ctx !== kiloclawInstanceContext(sandboxId)) return null;
  return conversationsKey(sandboxId);
}
