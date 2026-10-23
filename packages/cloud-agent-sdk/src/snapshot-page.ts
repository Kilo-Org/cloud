import type { ChatEvent } from './normalizer';
import type { SessionSnapshot, SessionSnapshotPage, SessionSnapshotPageOutcome } from './types';
import { partSettledAt } from './part-utils';
import type { TransportSink } from './transport';

export type SessionSnapshotFailureKind = Exclude<SessionSnapshotPageOutcome['kind'], 'success'>;

/**
 * Callers that still read the whole transcript in one call hand back a
 * `SessionSnapshot`; the replay path only understands pages, so present the
 * bounded-read shape with no older items behind it.
 */
export function snapshotPageFromSnapshot(snapshot: SessionSnapshot): SessionSnapshotPage {
  return {
    info: snapshot.info,
    messages: snapshot.messages,
    nextCursor: null,
    omittedItemCount: 0,
  };
}

/**
 * Emit a stored transcript's messages in render order. A settled tool part
 * carries the `time.end` its lifecycle merge orders it by; nothing else
 * carries an event time.
 */
export function replayStoredMessages(
  messages: SessionSnapshot['messages'],
  emit: (event: ChatEvent) => void
): void {
  for (const msg of messages) {
    emit({ type: 'message.updated', info: msg.info });

    for (const part of msg.parts) {
      const settledAt = partSettledAt(part);
      emit({
        type: 'message.part.updated',
        part,
        ...(settledAt === undefined ? {} : { time: settledAt }),
      });
    }
  }
}

export function replaySnapshotPage(sink: TransportSink, page: SessionSnapshotPage): void {
  sink.onServiceEvent({ type: 'session.created', info: page.info });

  replayStoredMessages(page.messages, event => sink.onChatEvent(event));
}

export function replaySnapshot(sink: TransportSink, snapshot: SessionSnapshot): void {
  replaySnapshotPage(sink, snapshotPageFromSnapshot(snapshot));
}

export function sessionSnapshotFailureMessage(kind: SessionSnapshotFailureKind): string {
  switch (kind) {
    case 'retryable_failure':
      return 'Session history temporarily unavailable';
    case 'too_large':
      return 'Session history too large to load';
    case 'invalid_data':
      return 'Session history is unavailable';
  }
}
