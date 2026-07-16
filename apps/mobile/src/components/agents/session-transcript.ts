import { isNoOpCompletedPreparationAttempt } from 'cloud-agent-sdk/preparation-attempts';
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
  // `ensureWrapper` records a completed attempt for every message delivery,
  // even warm reuse. Drop no-op completed attempts so "Environment prepared"
  // surfaces only for genuine cold starts. Running and failed attempts are
  // always kept: live progress may still arrive, and failures must stay visible.
  const visibleAttempts = preparationAttempts.filter(
    attempt => !isNoOpCompletedPreparationAttempt(attempt)
  );

  const byMessageId = new Map<string, PreparationAttempt[]>();
  for (const attempt of visibleAttempts) {
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
  for (const attempt of visibleAttempts) {
    if (!messageIds.has(attempt.triggerMessageId)) {
      items.push({ type: 'preparation', attempt });
    }
  }
  return items;
}
