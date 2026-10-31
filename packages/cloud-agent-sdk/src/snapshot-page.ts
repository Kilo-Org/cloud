import type { ChatEvent, ChatEventVersion } from './normalizer';
import { messageUpdatedDataSchema } from './schemas';
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
 *
 * Replay is the counterpart of the per-event boundary: the transports hand a
 * stored page straight to the sink, so no event schema runs on it. Each row is
 * therefore checked against the same message contract the live wire uses, and a
 * row the transcript cannot describe — no readable `time` for its timestamp and
 * streaming state, no `role` for its branch — is skipped together with its
 * parts instead of being handed to readers. One bad row must not cost the rest
 * of the page.
 */
export function replayStoredMessages(
  messages: SessionSnapshot['messages'],
  emit: (event: ChatEvent) => void,
  version?: ChatEventVersion
): void {
  for (const msg of messages) {
    if (!messageUpdatedDataSchema.safeParse({ info: msg.info }).success) continue;
    emit({ type: 'message.updated', info: msg.info, ...(version ? { version } : {}) });

    for (const part of msg.parts) {
      const settledAt = partSettledAt(part);
      emit({
        type: 'message.part.updated',
        part,
        ...(version ? { version } : {}),
        ...(settledAt === undefined ? {} : { time: settledAt }),
      });
    }
  }
}

export function replaySnapshotPage(
  sink: TransportSink,
  page: SessionSnapshotPage,
  version?: ChatEventVersion
): void {
  sink.onServiceEvent({ type: 'session.created', info: page.info });

  replayStoredMessages(page.messages, event => sink.onChatEvent(event), version);
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
