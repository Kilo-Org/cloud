import {
  type MessageDeliveryState,
  type PreparationAttempt,
  type StoredMessage,
} from '@kilocode/cloud-agent-sdk';

import {
  type SessionTranscriptItem,
  type SessionTranscriptTimeMarker,
} from './session-transcript-types';

type MessageItem = Extract<SessionTranscriptItem, { type: 'message' }>;

/**
 * Per-row memo for the transcript items `mergeSessionTranscript` builds. The SDK
 * keeps a row's `StoredMessage` object identity across a streamed delta on
 * another row, so an unchanged message reuses the exact item object from the
 * previous build — same message object, same time marker, same delivery state —
 * and every memoized row below it keeps its identity. The marker is compared by
 * value because a prepend can move it onto a different message. WeakMaps so a
 * discarded message or attempt takes its cached item with it.
 */
type CachedMessageItem = {
  item: MessageItem;
  markerCreated: number | undefined;
  markerDayChanged: boolean | undefined;
  deliveryStatus: MessageDeliveryState['status'] | undefined;
};

const messageItemMemo = new WeakMap<StoredMessage, CachedMessageItem>();
const preparationItemMemo = new WeakMap<PreparationAttempt, SessionTranscriptItem>();

/** The identity-stable `message` item for one row, rebuilt only when its inputs change. */
export function memoizedMessageItem(
  message: StoredMessage,
  timeMarker: SessionTranscriptTimeMarker | undefined,
  deliveryStatus: MessageDeliveryState['status'] | undefined
): MessageItem {
  const cached = messageItemMemo.get(message);
  if (
    cached !== undefined &&
    cached.markerCreated === timeMarker?.created &&
    cached.markerDayChanged === timeMarker?.dayChanged &&
    cached.deliveryStatus === deliveryStatus
  ) {
    return cached.item;
  }
  const item: MessageItem = {
    type: 'message',
    message,
    ...(timeMarker ? { timeMarker } : {}),
  };
  messageItemMemo.set(message, {
    item,
    markerCreated: timeMarker?.created,
    markerDayChanged: timeMarker?.dayChanged,
    deliveryStatus,
  });
  return item;
}

/** The identity-stable `preparation` item for one attempt. */
export function memoizedPreparationItem(attempt: PreparationAttempt): SessionTranscriptItem {
  const cached = preparationItemMemo.get(attempt);
  if (cached !== undefined) {
    return cached;
  }
  const item: SessionTranscriptItem = { type: 'preparation', attempt };
  preparationItemMemo.set(attempt, item);
  return item;
}
