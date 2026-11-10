import type { SessionDataItem } from '../types/session-sync';

/**
 * Item-id root of a `part`: parts key their rows under `part/<messageId>/<partId>`.
 */
const PART_ITEM_ID_ROOT = 'part';

export type PartItemIdentityRange = { start: string; end: string };

export type PartItemIdentity = {
  messageId: string;
  partId: string;
  layout: 'current' | 'previous';
};

export function getPartItemIdentity(messageId: string, partId: string): string {
  return `${PART_ITEM_ID_ROOT}/${messageId}/${partId}`;
}

/**
 * Item id a part row can carry from the older stored layout (`<messageId>/<partId>`). Readers
 * return such rows, and ingest replaces one when it rewrites the same part.
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

/** Both layout ranges of a message's parts, current layout first. */
export function getPartItemIdentityRanges(messageId: string): PartItemIdentityRange[] {
  return [getPartItemIdentityRange(messageId), getPreviousPartItemIdentityRange(messageId)];
}

export type PartItemRowPosition = {
  id: number;
  ingested_at: number | null;
  item_id: string;
};

/**
 * Yields one message's part rows in `order`, reading one `item_id` range per layout.
 *
 * One range per layout keeps every read on the `item_id` index. Each layout pages with its own
 * cursor, and the two streams are merged as they are read.
 */
export function* streamMessagePartRows<T extends PartItemRowPosition>(options: {
  messageId: string;
  order: 'row-id' | 'ingest';
  batchSize: number;
  fetchPage: (range: PartItemIdentityRange, after: T | undefined, limit: number) => T[];
}): Generator<T> {
  const { messageId, order, batchSize, fetchPage } = options;
  const compare =
    order === 'ingest' ? comparePartIngestOrder : (left: T, right: T) => left.id - right.id;
  const sources = getPartItemIdentityRanges(messageId).map((range, index) => ({
    layout: index === 0 ? ('current' as const) : ('previous' as const),
    range,
    buffer: [] as T[],
    after: undefined as T | undefined,
    done: false,
  }));

  for (;;) {
    for (const source of sources) {
      if (source.done || source.buffer.length > 0) continue;
      const page = fetchPage(source.range, source.after, batchSize);
      source.buffer = page.filter(row => {
        const identity = parsePartItemIdentity(row.item_id);
        // Rows of the other layout are skipped here; ids with no part identity are passed through
        // for the caller to validate.
        return identity === null || identity.layout === source.layout;
      });
      const lastRow = page[page.length - 1];
      if (lastRow !== undefined) source.after = lastRow;
      source.done = page.length < batchSize;
    }

    let next: T | undefined;
    let nextSource: (typeof sources)[number] | undefined;
    for (const source of sources) {
      const head = source.buffer[0];
      if (head === undefined) continue;
      if (next === undefined || compare(head, next) < 0) {
        next = head;
        nextSource = source;
      }
    }
    if (next === undefined || nextSource === undefined) {
      // A page can be read and skipped in full, leaving a layout with rows still unread.
      if (sources.every(source => source.done && source.buffer.length === 0)) return;
      continue;
    }
    nextSource.buffer.shift();
    yield next;
  }
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
 * `<messageId>/<partId>` is the older one.
 */
export function parsePartItemIdentity(itemId: string): PartItemIdentity | null {
  const segments = itemId.split('/');
  if (segments.length === 3 && segments[0] === PART_ITEM_ID_ROOT) {
    return { messageId: segments[1], partId: segments[2], layout: 'current' };
  }
  if (segments.length === 2) {
    return { messageId: segments[0], partId: segments[1], layout: 'previous' };
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
