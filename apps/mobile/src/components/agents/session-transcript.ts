import { type PreparationAttempt, type StoredMessage } from 'cloud-agent-sdk';

export type SessionTranscriptItem =
  | { type: 'message'; message: StoredMessage }
  | { type: 'preparation'; attempt: PreparationAttempt };

export function getSessionTranscriptItemKey(item: SessionTranscriptItem): string {
  return item.type === 'message' ? item.message.info.id : `preparation:${item.attempt.id}`;
}

export function mergeSessionTranscript(
  messages: readonly StoredMessage[],
  preparationAttempts: readonly PreparationAttempt[]
): SessionTranscriptItem[] {
  const byMessageId = new Map<string, PreparationAttempt[]>();
  for (const attempt of preparationAttempts) {
    const attempts = byMessageId.get(attempt.triggerMessageId) ?? [];
    byMessageId.set(attempt.triggerMessageId, [...attempts, attempt]);
  }

  const items: SessionTranscriptItem[] = [];
  const messageIds = new Set<string>();
  for (const message of messages) {
    messageIds.add(message.info.id);
    items.push({ type: 'message', message });
    for (const attempt of byMessageId.get(message.info.id) ?? []) {
      items.push({ type: 'preparation', attempt });
    }
  }
  for (const attempt of preparationAttempts) {
    if (!messageIds.has(attempt.triggerMessageId)) {
      items.push({ type: 'preparation', attempt });
    }
  }
  return items;
}
