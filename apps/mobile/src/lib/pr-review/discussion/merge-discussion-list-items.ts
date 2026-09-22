// One-pass decorated form of the Discussion tab's merge/sort.
//
// `mergeDiscussionListItems` sorts with `compareDiscussionListItems`, whose
// comparator reads (and `parseTimestamp`s) each item's raw timestamp on every
// comparison — twice per comparison, so thousands of parses per merge on a PR
// with a few hundred loaded rows. Both inputs to the tab's merge are
// identity-stable, but the tab re-renders on every expand/collapse tap,
// optimistic reaction/resolve and reply-focus event, so that cost lands on the
// interaction that caused the render.
//
// This module reads each item's raw timestamp once, carries a precomputed
// `{ hasMs, ms }` key, sorts on that key, and delegates exact ties to
// `compareDiscussionListItems` so the A2.2 total order is identical to
// `mergeDiscussionListItems` for every input.

import {
  compareDiscussionListItems,
  type ConversationComment,
  type DiscussionListItem,
  type ReviewThread,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { parseTimestamp } from '@/lib/utils';

type DecoratedDiscussionListItem = {
  readonly item: DiscussionListItem;
  /** False when the item has no usable timestamp (missing or unparseable). */
  readonly hasMs: boolean;
  /** The parsed key; meaningless (0) when `hasMs` is false. */
  readonly ms: number;
};

/**
 * The A2.2 sort key, read once per item: the first comment's `createdAt` for a
 * thread, the comment's own `createdAt` for a conversation comment. `null`
 * means missing or unparseable; those items sort after every timed item.
 */
function timestampMsFor(item: DiscussionListItem): number | null {
  const raw =
    item.kind === 'thread' ? (item.thread.comments[0]?.createdAt ?? null) : item.comment.createdAt;
  if (raw == null || raw === '') {
    return null;
  }
  const ms = parseTimestamp(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function decorateForMerge(item: DiscussionListItem): DecoratedDiscussionListItem {
  const ms = timestampMsFor(item);
  return { item, hasMs: ms !== null, ms: ms ?? 0 };
}

/**
 * Same total order as `compareDiscussionListItems`, but the timestamp key is
 * precomputed. Exact ties (or two missing timestamps) delegate to the shared
 * comparator for the kind/identity tie-break.
 */
function compareDecoratedItems(
  a: DecoratedDiscussionListItem,
  b: DecoratedDiscussionListItem
): number {
  if (a.hasMs && b.hasMs && a.ms !== b.ms) {
    return a.ms - b.ms;
  }
  if (a.hasMs !== b.hasMs) {
    return a.hasMs ? -1 : 1;
  }
  return compareDiscussionListItems(a.item, b.item);
}

/**
 * Merge review threads and conversation comments into one ascending list,
 * parsing each item's timestamp once per merge instead of once per comparison.
 * Order-equivalent to `mergeDiscussionListItems` (R4: a "Load more" page can
 * insert rows mid-list; the whole loaded set is re-sorted).
 */
export function mergeDiscussionListItemsBySortKey(
  threads: readonly ReviewThread[],
  conversation: readonly ConversationComment[]
): readonly DiscussionListItem[] {
  const decorated: DecoratedDiscussionListItem[] = [
    ...threads.map(thread => decorateForMerge({ kind: 'thread', thread })),
    ...conversation.map(comment => decorateForMerge({ kind: 'comment', comment })),
  ];
  decorated.sort(compareDecoratedItems);
  return decorated.map(entry => entry.item);
}
