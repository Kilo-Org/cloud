import type { Turn } from '@kilocode/harness-sdk';

/**
 * The one seam between the chat registry and sync: the registry announces a
 * settled exchange here, and the sync service (registered by whichever
 * layer owns the account's gate) uploads it. Kept apart so the registry
 * never imports the sync engine.
 */

export type ChatSettledListener = (sessionId: string, turns: readonly Turn[]) => void;

const listeners = new Set<ChatSettledListener>();

export function onChatSettled(listener: ChatSettledListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyChatSettled(sessionId: string, turns: readonly Turn[]): void {
  for (const listener of listeners) {
    listener(sessionId, turns);
  }
}
