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

/**
 * A burst-opening time marker. It rides on the first item a message row emits so
 * a prepend can never add, remove, or re-key a row that is already on screen: the
 * marker moves to the older message while every message keeps its `info.id` key.
 */
type SessionTranscriptTimeMarker = { created: number; dayChanged: boolean };

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
      timeMarker?: SessionTranscriptTimeMarker;
    }
  | { type: 'preparation'; attempt: PreparationAttempt }
  | {
      type: 'tool-run';
      id: string;
      /** The run's first part's message id, for resume-anchor matching. */
      messageId: string;
      parts: ToolPart[];
      timeMarker?: SessionTranscriptTimeMarker;
    };

/**
 * A time marker opens a run of messages. Below this gap the messages belong to the
 * same working burst and repeat the same minute, so a second marker adds nothing.
 * Evidence: in the user's transcript one agent turn stepped 3:37 → 3:42 → 3:49 →
 * 3:53, so the largest gap inside a live turn was 7 minutes. Ten minutes keeps a
 * live turn under one marker and still marks a real pause.
 */
export const TRANSCRIPT_TIME_MARKER_GAP_MS = 10 * 60 * 1000;

/**
 * Whether this row is client-materialised for a prompt the server has not
 * confirmed: the send-time optimistic insert and the `cloud.message.queued`
 * synthesize both write `info.synthetic` (the same Kilo extension their
 * placeholder parts carry). The authoritative `message.updated` replaces the
 * info and clears the flag; when that update never lands — production has
 * shown the wrapper's event publications rejected wholesale
 * (`event_batch_rejected`) — the row stays unconfirmed for a submission the
 * server may never have accepted.
 */
function isUnconfirmedSubmission(message: StoredMessage): boolean {
  return message.info.role === 'user' && message.info.synthetic === true;
}

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
  return item.id;
}

/**
 * The item key each rendered part had in one transcript build, keyed by part id.
 * A condensed row's key is derived from the parts it holds, so a later build
 * cannot recompute the key a row was born with from its parts alone. Carrying
 * this map from the previous build lets `condenseTranscriptToolRuns` keep a row's
 * existing key when a prepend or a streaming part changes the run's first part.
 */
export type TranscriptItemKeysByPart = ReadonlyMap<string, string>;

/**
 * Records, for every part an item renders, the key of the item that renders it.
 * A `message` item maps the subset it actually renders (`item.parts` when a
 * condensed run split the message, else every content-rendering part); a
 * `tool-run` item maps the parts it holds; a preparation attempt renders no part
 * and is skipped.
 */
export function collectTranscriptItemKeysByPart(
  items: readonly SessionTranscriptItem[]
): Map<string, string> {
  const keysByPart = new Map<string, string>();
  for (const item of items) {
    if (item.type !== 'preparation') {
      const key = getSessionTranscriptItemKey(item);
      const parts =
        item.type === 'tool-run'
          ? item.parts
          : (item.parts ?? item.message.parts).filter(part => partRendersContent(part));
      for (const part of parts) {
        keysByPart.set(part.id, key);
      }
    }
  }
  return keysByPart;
}

/**
 * FlashList's recycling bucket. A row's view shape follows its kind and, for a
 * message, its role and failure state: a user bubble and an assistant bubble
 * share no layout, and a failed turn adds a footer with Retry. Recycling across
 * those shapes would reuse the wrong view, so the bucket names them separately.
 * The time marker never changes the bucket: its presence flips for the boundary
 * row on every prepend, and a changing bucket would only defeat recycling.
 */
export function getSessionTranscriptItemType(item: SessionTranscriptItem): string {
  if (item.type === 'message') {
    const info = item.message.info;
    if (info.role === 'assistant' && info.error) {
      return 'message-error';
    }
    return info.role === 'user' ? 'message-user' : 'message-assistant';
  }
  return item.type;
}

/**
 * The message id a resume anchor matches this item by: a message row's own id
 * (the burst marker now rides on that row, so it adds no case of its own), or a
 * condensed run's first part's message. A preparation attempt has no message row
 * of its own, so it can never be an anchor target.
 */
export function getSessionTranscriptItemMessageId(item: SessionTranscriptItem): string | null {
  if (item.type === 'message') {
    return item.message.info.id;
  }
  if (item.type === 'preparation') {
    return null;
  }
  return item.messageId;
}

/**
 * Whether `mergeSessionTranscript` emits a row for this message: it renders
 * content, or its delivery failed and its typed footer is the row's own
 * surface. Everything else is dropped and cannot own a failure row.
 *
 * An unconfirmed row with no parts at all stays invisible: unlike a confirmed
 * user row (whose parts may still stream in, so a zero-part row stays
 * transient), a client materialised row that never received its parts will not
 * gain content on its own — it would otherwise leave the reported empty yellow
 * stub above the submitted text. A synthetic row whose parts exist but render
 * nothing is already dropped by `messageRendersContent`, so this rule only has
 * to name the zero-part case. The row is keyed by the id the client sent (the
 * server honors `messageId`), so the run that failed it attaches here and a
 * failed submission keeps its one row with the typed footer. Two rows with the
 * same prompt are two submissions and stay two rows. If the server later
 * confirms the id, the authoritative record replaces the info and the row
 * re-renders through the normal path.
 */
export function transcriptRendersMessage(
  message: StoredMessage,
  deliveryStates?: ReadonlyMap<string, MessageDeliveryState>
): boolean {
  const failed = deliveryStates?.get(message.info.id)?.status === 'failed';
  const unconfirmedWithoutParts =
    isUnconfirmedSubmission(message) && !failed && message.parts.length === 0;
  return !unconfirmedWithoutParts && (messageRendersContent(message) || failed);
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
    if (transcriptRendersMessage(message, deliveryStates)) {
      const created = message.info.time.created;
      // One validity rule, shared with the marker component: a timestamp the label
      // cannot format must never produce a marker.
      let timeMarker: { created: number; dayChanged: boolean } | undefined = undefined;
      if (isValidTranscriptTime(created)) {
        const dayChanged =
          previousCreated !== undefined && !isSameLocalDay(created, previousCreated);
        if (
          previousCreated === undefined ||
          dayChanged ||
          created - previousCreated >= TRANSCRIPT_TIME_MARKER_GAP_MS
        ) {
          timeMarker = { created, dayChanged };
        }
        previousCreated = created;
      }
      items.push({ type: 'message', message, ...(timeMarker ? { timeMarker } : {}) });
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
 * the subset of parts to render in `parts`. Every other item — a preparation
 * attempt, a user message, or a message-level failure (`info.error`) — flushes the
 * run and passes through whole, so a failed turn keeps its failure footer and
 * Retry. Without `carriedKeysByPart` the id is derived from the run's first part,
 * so it stays stable while later parts stream into the same run.
 *
 * `carriedKeysByPart` is the previous build's part→item-key map (see
 * `collectTranscriptItemKeysByPart`). When a run of two or more holds a part that
 * an earlier build rendered under its own key — a lone tool part that has just
 * become a run, or a run whose earlier parts a prepend pushed behind it — the run
 * reuses that key instead of re-keying. FlashList anchors the viewport on the
 * first visible row's key, so keeping the key is what stops the jump when an older
 * page prepends.
 *
 * A time marker now rides on the message that opens its burst. It stays a run
 * boundary here, exactly as the standalone marker item was, and moves onto the
 * first item that message emits: condensing changes neither the rows nor the
 * markers the reader saw before the marker was folded into the message.
 */
export function condenseTranscriptToolRuns(
  items: readonly SessionTranscriptItem[],
  carriedKeysByPart?: TranscriptItemKeysByPart
): SessionTranscriptItem[] {
  const condensed: SessionTranscriptItem[] = [];

  const emit = (item: SessionTranscriptItem) => {
    condensed.push(item);
  };

  // The maximal run of consecutive condensable tool parts, each with its source
  // message so a run of one can fall back to that message's plain rendering.
  let run: { message: StoredMessage; part: ToolPart }[] = [];

  // The marker of the message that opened the current run, moved onto the run
  // item when it closes.
  let runMarker: SessionTranscriptTimeMarker | undefined = undefined;

  // The marker of the message being processed that has not reached an item yet.
  // A marked message emits at most one item that can open it — its first tool
  // run or its first plain fragment — and the marker lands on that one.
  let pendingMarker: SessionTranscriptTimeMarker | undefined = undefined;

  // The pending plain stretch of one message: the visible parts that are not in
  // the current run, emitted as a `message` item once the run closes.
  let fragment: {
    message: StoredMessage;
    parts: Part[];
    visibleCount: number;
    marker?: SessionTranscriptTimeMarker;
  } | null = null;

  const flushFragment = () => {
    if (fragment === null) {
      return;
    }
    const { message, parts, visibleCount, marker } = fragment;
    fragment = null;
    if (parts.length === 0) {
      return;
    }
    // A fragment holding every visible part is the unchanged message: emit it
    // without `parts` so its item key and render path stay identical.
    if (parts.length === visibleCount) {
      emit({ type: 'message', message, ...(marker ? { timeMarker: marker } : {}) });
    } else {
      emit({
        type: 'message',
        message,
        parts,
        ...(marker ? { timeMarker: marker } : {}),
      });
    }
  };

  const appendPlain = (message: StoredMessage, part: Part, visibleCount: number) => {
    if (fragment !== null && fragment.message !== message) {
      flushFragment();
    }
    if (fragment === null) {
      fragment = {
        message,
        parts: [part],
        visibleCount,
        ...(pendingMarker ? { marker: pendingMarker } : {}),
      };
      pendingMarker = undefined;
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
      const first = run[0];
      emit({
        type: 'tool-run',
        id: `tool-run:${first?.part.id ?? ''}`,
        messageId: first?.message.info.id ?? '',
        parts: run.map(entry => entry.part),
        ...(runMarker ? { timeMarker: runMarker } : {}),
      });
    } else {
      const only = run[0];
      if (only) {
        // A run of one falls back to its message's plain rendering. Forward the
        // marker that opened the run onto that fallback fragment, or a marked
        // message whose first visible part is a single tool call loses its
        // marker. `pendingMarker` is always clear here (starting the run
        // consumed it), so resetting it after the append cannot drop a live
        // marker meant for the next message.
        pendingMarker = runMarker;
        appendPlain(only.message, only.part, visiblePartCount(only.message));
        pendingMarker = undefined;
      }
    }
    run = [];
    runMarker = undefined;
  };

  const appendVisibleParts = (item: Extract<SessionTranscriptItem, { type: 'message' }>) => {
    const { message } = item;
    pendingMarker = item.timeMarker;
    const visible = message.parts.filter(part => partRendersContent(part));
    if (visible.length === 0) {
      const marker = pendingMarker;
      pendingMarker = undefined;
      flushRun();
      flushFragment();
      emit(
        marker ? { type: 'message', message, timeMarker: marker } : { type: 'message', message }
      );
      return;
    }
    for (const part of visible) {
      if (isCondensableToolPart(part)) {
        if (run.length === 0) {
          runMarker = pendingMarker;
          pendingMarker = undefined;
        }
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
      // A marker opens a burst, so it ends the previous run before its own
      // message can join one — the split the standalone marker item forced.
      if (item.timeMarker) {
        flushRun();
        flushFragment();
      }
      appendVisibleParts(item);
    } else {
      flushRun();
      flushFragment();
      emit(item);
    }
  }
  flushRun();
  flushFragment();
  if (!carriedKeysByPart) {
    return condensed;
  }

  // Reserve every current row's key before reusing old ones. A run can carry a
  // later message's id (or another run's fallback key) after a prepend, then
  // split away from that row on the next build.
  const reservedKeys = new Set(condensed.map(item => getSessionTranscriptItemKey(item)));
  const emittedKeys = new Set<string>();
  for (const [index, item] of condensed.entries()) {
    if (item.type === 'tool-run') {
      const carriedKey = item.parts
        .map(part => carriedKeysByPart.get(part.id))
        .find(
          key =>
            key !== undefined &&
            !emittedKeys.has(key) &&
            (!reservedKeys.has(key) || key === item.id)
        );
      const id = carriedKey ?? item.id;
      emittedKeys.add(id);
      if (id !== item.id) {
        condensed[index] = { ...item, id };
      }
    }
  }
  return condensed;
}
