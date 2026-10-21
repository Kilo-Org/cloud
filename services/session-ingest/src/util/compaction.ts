import type { SessionDataItem } from '../types/session-sync';

/**
 * Item-id root of a `part`. Every item type owns a distinct identity namespace, so a part keeps
 * its own root alongside `message/` and `agent_notification/`.
 */
const PART_ITEM_ID_ROOT = 'part';

export type PartItemIdentityRange = { start: string; end: string };

export type PartItemIdentity = { messageId: string; partId: string };

export function getPartItemIdentity(messageId: string, partId: string): string {
  return `${PART_ITEM_ID_ROOT}/${messageId}/${partId}`;
}

/**
 * Identity of a part stored before parts had their own namespace. Rows written under it stay
 * readable: readers return them and ingest replaces one once it rewrites the same part.
 */
export function getPreviousPartItemIdentity(messageId: string, partId: string): string {
  return `${messageId}/${partId}`;
}

export function getPartItemIdentityRange(messageId: string): PartItemIdentityRange {
  return prefixRange(`${PART_ITEM_ID_ROOT}/${messageId}`);
}

export function getPreviousPartItemIdentityRange(messageId: string): PartItemIdentityRange {
  return prefixRange(messageId);
}

function prefixRange(prefix: string): PartItemIdentityRange {
  // Under SQLite's default BINARY collation, '/' sorts immediately before '0', so every id that
  // starts with `${prefix}/` sorts inside this half-open range and nothing else does.
  return { start: `${prefix}/`, end: `${prefix}0` };
}

/** Both identities a message's parts can live under, current layout first. */
export function getPartItemIdentityRanges(messageId: string): PartItemIdentityRange[] {
  return [getPartItemIdentityRange(messageId), getPreviousPartItemIdentityRange(messageId)];
}

/**
 * Runs one read per part identity layout and merges the results in `compare` order.
 *
 * A single `item_id` range per layout keeps each read on the `item_id` index; an OR over both
 * ranges makes SQLite fall back to a rowid scan of every part row in the session, so the merge
 * happens here instead. Each read pages with the caller's cursor, so both stay bounded.
 */
export function mergePartIdentityRanges<T>(
  messageId: string,
  read: (range: PartItemIdentityRange) => T[],
  compare: (left: T, right: T) => number
): T[] {
  const [current, previous] = getPartItemIdentityRanges(messageId).map(read);
  const merged: T[] = [];
  let currentIndex = 0;
  let previousIndex = 0;
  while (currentIndex < current.length && previousIndex < previous.length) {
    if (compare(current[currentIndex], previous[previousIndex]) <= 0) {
      merged.push(current[currentIndex]);
      currentIndex += 1;
    } else {
      merged.push(previous[previousIndex]);
      previousIndex += 1;
    }
  }
  merged.push(...current.slice(currentIndex), ...previous.slice(previousIndex));
  return merged;
}

/** Emission order of ingest rows: `ingested_at` (nulls first), then the row id. */
export function comparePartIngestOrder(
  left: { ingested_at: number | null; id: number },
  right: { ingested_at: number | null; id: number }
): number {
  const leftIngestedAt = left.ingested_at ?? -Infinity;
  const rightIngestedAt = right.ingested_at ?? -Infinity;
  return leftIngestedAt === rightIngestedAt ? left.id - right.id : leftIngestedAt - rightIngestedAt;
}

/**
 * Splits a stored part id under either layout. `part/<messageId>/<partId>` is the current layout;
 * `<messageId>/<partId>` is the previous one, where the message id may itself be `part`.
 */
export function parsePartItemIdentity(itemId: string): PartItemIdentity | null {
  const segments = itemId.split('/');
  if (segments.length === 3 && segments[0] === PART_ITEM_ID_ROOT) {
    return { messageId: segments[1], partId: segments[2] };
  }
  if (segments.length === 2) {
    return { messageId: segments[0], partId: segments[1] };
  }
  return null;
}

export function getItemIdentity(item: SessionDataItem): {
  item_id: string;
  item_type: SessionDataItem['type'];
} {
  switch (item.type) {
    case 'session':
      return { item_id: 'session', item_type: 'session' };
    case 'message':
      return { item_id: `message/${item.data.id}`, item_type: 'message' };
    case 'part':
      return {
        item_id: getPartItemIdentity(item.data.messageID, item.data.id),
        item_type: 'part',
      };
    case 'session_diff':
      return { item_id: 'session_diff', item_type: 'session_diff' };
    case 'model':
      return { item_id: 'model', item_type: 'model' };
    case 'kilo_meta':
      return { item_id: 'kilo_meta', item_type: 'kilo_meta' };
    case 'session_open':
      return { item_id: 'session_open', item_type: 'session_open' };
    case 'session_close':
      return { item_id: 'session_close', item_type: 'session_close' };
    case 'session_status':
      return { item_id: 'session_status', item_type: 'session_status' };
    case 'agent_notification':
      return {
        item_id: `agent_notification/${item.data.id}`,
        item_type: 'agent_notification',
      };
    case 'session_pr_link':
      return { item_id: 'session_pr_link', item_type: 'session_pr_link' };
    default:
      throw new Error(`Unknown item type: ${String((item as SessionDataItem)['type'])}`);
  }
}
