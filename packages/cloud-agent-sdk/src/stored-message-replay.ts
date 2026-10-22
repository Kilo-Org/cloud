import type { ChatEvent } from './normalizer';
import { partSettledAt } from './part-utils';
import type { SessionSnapshot } from './types';

/**
 * A part's event carries its settle time as `time`, which is the ordering
 * evidence storage compares a replayed part against newer stored state.
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
