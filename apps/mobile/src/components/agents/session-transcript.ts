import { isNoOpCompletedPreparationAttempt } from '@kilocode/cloud-agent-sdk/preparation-attempts';
import { type PreparationAttempt, type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { isSameLocalDay, isValidTranscriptTime } from './message-time-label';
import { messageRendersContent } from './message-visibility';

export type SessionTranscriptItem =
  | { type: 'message'; message: StoredMessage }
  | { type: 'preparation'; attempt: PreparationAttempt }
  | { type: 'time'; created: number; messageId: string; dayChanged: boolean };

/**
 * A time marker opens a run of messages. Below this gap the messages belong to the
 * same working burst and repeat the same minute, so a second marker adds nothing.
 * Evidence: in the user's transcript one agent turn stepped 3:37 → 3:42 → 3:49 →
 * 3:53, so the largest gap inside a live turn was 7 minutes. Ten minutes keeps a
 * live turn under one marker and still marks a real pause.
 */
export const TRANSCRIPT_TIME_MARKER_GAP_MS = 10 * 60 * 1000;

export function getSessionTranscriptItemKey(item: SessionTranscriptItem): string {
  if (item.type === 'message') {
    return item.message.info.id;
  }
  if (item.type === 'preparation') {
    return `preparation:${item.attempt.id}`;
  }
  return `time:${item.messageId}`;
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
  let previousCreated: number | undefined = undefined;
  for (const message of messages) {
    messageIds.add(message.info.id);
    if (messageRendersContent(message)) {
      const created = message.info.time.created;
      // One validity rule, shared with the marker component: a timestamp the label
      // cannot format must never produce a marker row.
      if (isValidTranscriptTime(created)) {
        const dayChanged =
          previousCreated !== undefined && !isSameLocalDay(created, previousCreated);
        if (
          previousCreated === undefined ||
          dayChanged ||
          created - previousCreated >= TRANSCRIPT_TIME_MARKER_GAP_MS
        ) {
          items.push({ type: 'time', created, messageId: message.info.id, dayChanged });
        }
        previousCreated = created;
      }
      items.push({ type: 'message', message });
    }
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
