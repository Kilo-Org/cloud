import { isNoOpCompletedPreparationAttempt } from '@kilocode/cloud-agent-sdk/preparation-attempts';
import {
  type MessageDeliveryState,
  type Part,
  type PreparationAttempt,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';

import { isSameLocalDay, isValidTranscriptTime } from './message-time-label';
import { messageRendersContent, partRendersContent } from './message-visibility';
import { isCondensableToolPart } from './session-tool-run';

export type SessionTranscriptItem =
  | {
      type: 'message';
      message: StoredMessage;
      /**
       * The exact subset of `message.parts` to render, set only when a condensed
       * run split the message around its visible parts. Omitted for an unchanged
       * message, whose full part list is rendered.
       */
      parts?: Part[];
    }
  | { type: 'preparation'; attempt: PreparationAttempt }
  | { type: 'tool-run'; id: string; parts: ToolPart[] }
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
    // A split message emits one item per plain stretch of its visible parts, so
    // the key must distinguish those items; the message id alone is not unique.
    return item.parts === undefined
      ? item.message.info.id
      : `message-parts:${item.message.info.id}:${item.parts[0]?.id ?? ''}`;
  }
  if (item.type === 'preparation') {
    return `preparation:${item.attempt.id}`;
  }
  if (item.type === 'tool-run') {
    return item.id;
  }
  return `time:${item.messageId}`;
}

export function getSessionTranscriptItemType(item: SessionTranscriptItem): string {
  return item.type;
}

export function mergeSessionTranscript(
  messages: readonly StoredMessage[],
  preparationAttempts: readonly PreparationAttempt[],
  deliveryStates?: ReadonlyMap<string, MessageDeliveryState>
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
    if (
      messageRendersContent(message) ||
      deliveryStates?.get(message.info.id)?.status === 'failed'
    ) {
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

/**
 * Merges consecutive condensable tool parts across the ordered visible part
 * stream into one `tool-run` item. Walking parts rather than whole messages means
 * a run that straddles a message containing visible text still reads as one
 * condensed row: a message's trailing tool run joins the following message's
 * leading run, and vice versa. A run of one re-renders its part through the
 * message's plain fragment, exactly as the per-part path would.
 *
 * A message whose visible parts all stay plain is re-emitted unchanged. A message
 * split around a run is emitted as one `message` item per plain stretch, carrying
 * the subset of parts to render in `parts`. Every other item — a time marker, a
 * preparation attempt, a user message, or a message-level failure (`info.error`)
 * — flushes the run and passes through whole, so a failed turn keeps its failure
 * footer and Retry. The id is derived from the run's first part, so it stays
 * stable while later parts stream into the same run and the FlashList key never
 * changes.
 */
export function condenseTranscriptToolRuns(
  items: readonly SessionTranscriptItem[]
): SessionTranscriptItem[] {
  const condensed: SessionTranscriptItem[] = [];

  // The maximal run of consecutive condensable tool parts, each with its source
  // message so a run of one can fall back to that message's plain rendering.
  let run: { message: StoredMessage; part: ToolPart }[] = [];

  // The pending plain stretch of one message: the visible parts that are not in
  // the current run, emitted as a `message` item once the run closes.
  let fragment: { message: StoredMessage; parts: Part[]; visibleCount: number } | null = null;

  const flushFragment = () => {
    if (fragment === null) {
      return;
    }
    const { message, parts, visibleCount } = fragment;
    fragment = null;
    if (parts.length === 0) {
      return;
    }
    // A fragment holding every visible part is the unchanged message: emit it
    // without `parts` so its item key and render path stay identical.
    condensed.push(
      parts.length === visibleCount
        ? { type: 'message', message }
        : { type: 'message', message, parts }
    );
  };

  const appendPlain = (message: StoredMessage, part: Part, visibleCount: number) => {
    if (fragment !== null && fragment.message !== message) {
      flushFragment();
    }
    if (fragment === null) {
      fragment = { message, parts: [part], visibleCount };
    } else {
      fragment.parts.push(part);
    }
  };

  const visiblePartCount = (message: StoredMessage): number =>
    message.parts.filter(part => partRendersContent(part)).length;

  const flushRun = () => {
    if (run.length === 0) {
      return;
    }
    if (run.length >= 2) {
      flushFragment();
      condensed.push({
        type: 'tool-run',
        id: `tool-run:${run[0]?.part.id ?? ''}`,
        parts: run.map(entry => entry.part),
      });
    } else {
      const only = run[0];
      if (only) {
        appendPlain(only.message, only.part, visiblePartCount(only.message));
      }
    }
    run = [];
  };

  const appendVisibleParts = (message: StoredMessage) => {
    const visible = message.parts.filter(part => partRendersContent(part));
    if (visible.length === 0) {
      flushRun();
      flushFragment();
      condensed.push({ type: 'message', message });
      return;
    }
    for (const part of visible) {
      if (isCondensableToolPart(part)) {
        run.push({ message, part });
      } else {
        flushRun();
        appendPlain(message, part, visible.length);
      }
    }
  };

  for (const item of items) {
    if (
      item.type === 'message' &&
      item.message.info.role === 'assistant' &&
      !item.message.info.error
    ) {
      appendVisibleParts(item.message);
    } else {
      flushRun();
      flushFragment();
      condensed.push(item);
    }
  }
  flushRun();
  flushFragment();
  return condensed;
}
