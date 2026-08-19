// Pure types, helpers, and reducers for the PR review Discussion tab.
//
// The discussion tab is built from three pure contracts:
//   1. The trpc DTO shapes (thread / comment / reaction) — these
//      mirror the committed S2 read DTO and S3 mutation DTOs.
//      We re-declare the narrowest types here (rather than depending
//      on the trpc root type) so the helpers stay testable in plain
//      Node and so the type contracts are explicit in this slice.
//   2. `selectThreadAnchorLabel` — turns a thread's nullable anchor
//      (file-level vs line-anchored vs outdated) into the label shown
//      in the thread header. Pure, no React.
//   3. `applyResolveToggle` and `applyReactionToggle` — pure cache
//      reducers that flip a single thread / comment in the
//      `InfiniteData<{threads, nextCursor}>` cache used by the
//      `listReviewThreads` infinite query. Used by the optimistic
//      `onMutate` of the resolve / unresolve / reaction mutations and
//      by the rollback in `onError`.
//
// Keeping these pure (no React, no trpc, no expo) means they can be
// unit-tested in plain Node and reused by the diff viewer if it later
// wants to compute its own indicators from the same cache.

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { parseTimestamp } from '@/lib/utils';

// GitHub's 8 review-comment reaction content values. The trpc DTO
// exposes this as a plain `string`; we narrow to the union here so
// the reducer and the pill row get exhaustiveness checking.
export type ReviewReactionContent =
  | 'THUMBS_UP'
  | 'THUMBS_DOWN'
  | 'LAUGH'
  | 'HOORAY'
  | 'CONFUSED'
  | 'HEART'
  | 'ROCKET'
  | 'EYES';

export const REVIEW_REACTION_CONTENTS: readonly ReviewReactionContent[] = [
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
] as const;

// Derive the wire (DTO) shapes from the tRPC `listReviewThreads` output so a
// backend contract change (fields, nullability) is type-checked here rather
// than silently drifting from a hand-copied shape (apps/mobile/AGENTS.md).
// `reactions[].content` is typed as a plain `string` by tRPC; we narrow it to
type RouterOutputs = inferRouterOutputs<MobileRouter>;
type ReviewThreadsPage = RouterOutputs['githubPrReview']['listReviewThreads'];
export type ReviewThread = ReviewThreadsPage['threads'][number];
export type ReviewComment = ReviewThread['comments'][number];
/** Conversation (issue) comments share the review-comment DTO shape. */
export type ConversationComment = ReviewThreadsPage['conversation'][number];

// The shape of a single page in the cached `InfiniteData<ReviewThreadsPage>`
// produced by `useInfiniteQuery(trpc.githubPrReview.listReviewThreads…)`.
export type ReviewThreadsInfiniteData = {
  readonly pages: readonly ReviewThreadsPage[];
  readonly pageParams: readonly unknown[];
};

/**
 * One row in the Discussion tab's merged chronological list.
 * Threads stay intact as single items (nested comments do not get
 * independent outer-list positions). Conversation comments are
 * individual rows.
 */
export type DiscussionListItem =
  | { readonly kind: 'thread'; readonly thread: ReviewThread }
  | { readonly kind: 'comment'; readonly comment: ConversationComment };

/**
 * Display label for a thread's anchor. The label reflects THREE
 * different nullable shapes:
 *   - file-level (`subjectType==='FILE'` or `line===null`):
 *     "File comment on <path>"
 *   - outdated (`isOutdated` true, with `originalLine`):
 *     "Outdated on <path> L<originalLine> (<diffSide>)"
 *   - active line:
 *     "<path> L<line> (<diffSide>)"  (or just L<line> if no path)
 *   - active range:
 *     "<path> L<startLine>–L<line> (<diffSide>)"
 */
export function selectThreadAnchorLabel(thread: ReviewThread): string {
  const path = thread.path ?? '';
  const side = thread.diffSide ? ` (${thread.diffSide})` : '';
  // Outdated threads anchor via `original*` (their current-line `line`
  // field is null because the diff has moved past the comment).
  if (thread.isOutdated) {
    const { originalLine } = thread;
    // No complete original anchor — fall back to a path-only outdated label
    // (never render a dangling "L").
    if (originalLine === null) {
      return path ? `Outdated on ${path}${side}` : `Outdated${side}`;
    }
    const original =
      thread.originalStartLine && thread.originalStartLine !== originalLine
        ? `L${thread.originalStartLine}–L${originalLine}`
        : `L${originalLine}`;
    return path ? `Outdated on ${path} ${original}${side}` : `Outdated on ${original}${side}`;
  }
  // File-level (subjectType FILE or no line) — only show path.
  if (thread.subjectType === 'FILE' || thread.line === null) {
    return path ? `File comment on ${path}` : 'File comment';
  }
  // Active line / range.
  const line =
    thread.startLine && thread.startLine !== thread.line
      ? `L${thread.startLine}–L${thread.line}`
      : `L${thread.line}`;
  return path ? `${path} ${line}${side}` : `${line}${side}`;
}

/**
 * Returns the same `isResolved` value with the `isOutdated` label
 * surfaced for the badges in the thread header. Purely presentational.
 */
export function selectThreadBadges(thread: ReviewThread) {
  return {
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    fileLevel: thread.subjectType === 'FILE' || thread.line === null,
  };
}

/**
 * Display name for a comment author. Returns "deleted user" when the
 * author is null (deleted / banned GitHub accounts surface as
 * `author: null` in the GraphQL DTO).
 */
export function selectCommentAuthorName(author: ReviewComment['author']): string {
  return author?.login ?? 'deleted user';
}

/**
 * Sort key timestamp for a discussion list item.
 * - Thread: first comment's `createdAt` (later replies stay nested).
 * - Conversation comment: its own `createdAt`.
 * Returns `null` when missing or unparseable so those items sort after
 * every item with a usable timestamp (A2.2 total-order rule).
 */
function discussionItemTimestampMs(item: DiscussionListItem): number | null {
  const raw =
    item.kind === 'thread' ? (item.thread.comments[0]?.createdAt ?? null) : item.comment.createdAt;
  if (raw == null || raw === '') {
    return null;
  }
  const ms = parseTimestamp(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function discussionItemIdentity(item: DiscussionListItem): string {
  return item.kind === 'thread' ? item.thread.threadId : item.comment.nodeId;
}

/**
 * A2.2 total order over every DTO-legal input:
 *   1. `createdAt` ascending (usable timestamps before missing/unparseable)
 *   2. threads before conversation comments on a tie
 *   3. stable string identity (`threadId` / `nodeId`) lexicographic
 */
export function compareDiscussionListItems(a: DiscussionListItem, b: DiscussionListItem): number {
  const aMs = discussionItemTimestampMs(a);
  const bMs = discussionItemTimestampMs(b);
  const aHas = aMs !== null;
  const bHas = bMs !== null;
  if (aHas && bHas && aMs !== bMs) {
    return aMs - bMs;
  }
  if (aHas !== bHas) {
    return aHas ? -1 : 1;
  }
  const aKind = a.kind === 'thread' ? 0 : 1;
  const bKind = b.kind === 'thread' ? 0 : 1;
  if (aKind !== bKind) {
    return aKind - bKind;
  }
  const aId = discussionItemIdentity(a);
  const bId = discussionItemIdentity(b);
  if (aId < bId) {
    return -1;
  }
  if (aId > bId) {
    return 1;
  }
  return 0;
}

/**
 * Merge review threads and conversation comments into one ascending list.
 *
 * Full re-sort of the **entire loaded set** on every call (R4 / plan
 * ordering rule): never rely on page arrival order (GitHub's
 * `reviewThreads` connection has no ordering guarantee), and never sort
 * only the newest page. A later "Load more" page can therefore insert
 * rows mid-list; that is accepted.
 *
 * Conversation comments are complete after page one; callers should pass
 * the first page's `conversation` (later pages are `[]` by contract).
 */
export function mergeDiscussionListItems(
  threads: readonly ReviewThread[],
  conversation: readonly ConversationComment[]
): readonly DiscussionListItem[] {
  const items: DiscussionListItem[] = [
    ...threads.map(thread => ({ kind: 'thread' as const, thread })),
    ...conversation.map(comment => ({ kind: 'comment' as const, comment })),
  ];
  items.sort(compareDiscussionListItems);
  return items;
}

/** Empty only when neither threads nor conversation comments are present. */
export function isDiscussionEmpty(
  threads: readonly ReviewThread[],
  conversation: readonly ConversationComment[]
): boolean {
  return threads.length === 0 && conversation.length === 0;
}

/**
 * Toggle a single thread's `isResolved` flag in the cached
 * `InfiniteData<ReviewThreadsPage>`. The reducer walks every page
 * and flips the matching threadId. Returns a new object so the
 * cache update is detected by react-query. Returns the same
 * reference when no thread matched or when the value is already
 * at the target state.
 */
export function applyResolveToggle(
  data: ReviewThreadsInfiniteData | undefined,
  threadId: string,
  nextIsResolved: boolean
): ReviewThreadsInfiniteData | undefined {
  if (!data) {
    return data;
  }
  const nextPages = data.pages.map(page => {
    const nextThreads = page.threads.map(thread =>
      thread.threadId === threadId && thread.isResolved !== nextIsResolved
        ? { ...thread, isResolved: nextIsResolved }
        : thread
    );
    const pageChanged = nextThreads.some((thread, index) => thread !== page.threads[index]);
    return pageChanged ? { ...page, threads: nextThreads } : page;
  });
  const changed = nextPages.some((page, index) => page !== data.pages[index]);
  return changed ? { ...data, pages: nextPages } : data;
}

/**
 * Toggle a single reaction in a single comment. When the viewer is
 * already reacted, the reaction is removed (count -1, viewerHasReacted
 * false). When the viewer is not yet reacted, it is added (count +1,
 * viewerHasReacted true). If the reaction's content is not in the
 * known set (unknown future GitHub value), it is treated as an
 * upsert by the existing-bucket path. If the bucket is not present
 * yet, it is appended. Returns a new InfiniteData so react-query
 * sees the change.
 */
export function applyReactionToggle(args: {
  data: ReviewThreadsInfiniteData | undefined;
  threadId: string;
  commentNodeId: string;
  content: string;
}): ReviewThreadsInfiniteData | undefined {
  const { data, threadId, commentNodeId, content } = args;
  if (!data) {
    return data;
  }
  const nextPages = data.pages.map(page => {
    const nextThreads = page.threads.map(thread => {
      if (thread.threadId !== threadId) {
        return thread;
      }
      const nextComments = thread.comments.map(comment => {
        if (comment.nodeId !== commentNodeId) {
          return comment;
        }
        const existing = comment.reactions.find(r => r.content === content);
        if (existing) {
          if (existing.viewerHasReacted) {
            // Remove: count -1, clear viewer flag. Guard against
            // underflow if the server count was already 0.
            return {
              ...comment,
              reactions: comment.reactions.map(r =>
                r.content === content
                  ? {
                      ...r,
                      count: Math.max(0, r.count - 1),
                      viewerHasReacted: false,
                    }
                  : r
              ),
            };
          }
          // Add to existing bucket.
          return {
            ...comment,
            reactions: comment.reactions.map(r =>
              r.content === content ? { ...r, count: r.count + 1, viewerHasReacted: true } : r
            ),
          };
        }
        // Reaction bucket not present yet — append a new one.
        return {
          ...comment,
          reactions: [...comment.reactions, { content, count: 1, viewerHasReacted: true }],
        };
      });
      const commentsChanged = nextComments.some(
        (comment, index) => comment !== thread.comments[index]
      );
      return commentsChanged ? { ...thread, comments: nextComments } : thread;
    });
    const pageChanged = nextThreads.some((thread, index) => thread !== page.threads[index]);
    return pageChanged ? { ...page, threads: nextThreads } : page;
  });
  const changed = nextPages.some((page, index) => page !== data.pages[index]);
  if (!changed) {
    return data;
  }
  return { ...data, pages: nextPages };
}

/**
 * Locate the thread + comment in the cached data. Returns `null` when
 * either is missing so the optimistic reducer can early-out.
 */
export function findReviewComment(
  data: ReviewThreadsInfiniteData | undefined,
  threadId: string,
  commentNodeId: string
): ReviewComment | null {
  if (!data) {
    return null;
  }
  for (const page of data.pages) {
    for (const thread of page.threads) {
      if (thread.threadId === threadId) {
        const match = thread.comments.find(comment => comment.nodeId === commentNodeId);
        if (match) {
          return match;
        }
      }
    }
  }
  return null;
}
