import type { ChatEvent } from './normalizer';
import { partSettledAt } from './part-utils';
import type { SessionSnapshot } from './types';

/**
 * Emit the chat events one stored message page replays, in the order storage
 * must apply them: the message row first, then each of its parts carrying the
 * settle time that orders them.
 *
 * Every snapshot, page and child-history replay — the manager's first/older
 * page and child hydration, and each transport's page replay — walks a page
 * through this function, so a new processor option, a change to the settle
 * time rule, or a new event field is made in one place instead of once per
 * replay loop.
 */
function replayStoredMessages(
  messages: SessionSnapshot['messages'],
  emit: (event: ChatEvent) => void
): void {
  for (const message of messages) {
    emit({ type: 'message.updated', info: message.info });
    for (const part of message.parts) {
      const settledAt = partSettledAt(part);
      emit({
        type: 'message.part.updated',
        part,
        ...(settledAt === undefined ? {} : { time: settledAt }),
      });
    }
  }
}

export { replayStoredMessages };
