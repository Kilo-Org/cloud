import {
  type SubmitReviewComment,
  type SubmitReviewInput,
} from '@/lib/pr-review/use-pr-review-mutations';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * GitHub rejects REQUEST_CHANGES and COMMENT reviews that carry neither a
 * summary nor at least one comment; APPROVE has no such requirement. Mirrored
 * client-side so the sheet can explain the requirement instead of round-
 * tripping to a 422.
 */
export function reviewSubmitBlockReason(args: {
  event: ReviewEvent;
  hasSummary: boolean;
  commentCount: number;
}): string | null {
  if (args.event === 'APPROVE') {
    return null;
  }
  if (args.hasSummary || args.commentCount > 0) {
    return null;
  }
  if (args.event === 'REQUEST_CHANGES') {
    return 'Add a summary or at least one comment to request changes.';
  }
  return 'Add a summary or at least one comment to post a comment review.';
}

type BuildSubmitReviewInputArgs = {
  owner: string;
  repo: string;
  number: number;
  event: ReviewEvent;
  body?: string;
  commitSha: string;
  items: readonly {
    path: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    startLine?: number;
    body: string;
  }[];
};

/**
 * Pure mapper from the pending-review queue + review event to the
 * `submitReview` tRPC input. The caller passes only the fresh items (those
 * whose `commitSha` matches the current head); stale items are never sent.
 *
 * Per the S3 contract, `startLine` and `startSide` must be supplied together
 * or omitted together.
 */
export function buildSubmitReviewInput(args: BuildSubmitReviewInputArgs): SubmitReviewInput {
  const comments: SubmitReviewComment[] = args.items.map(item => ({
    path: item.path,
    line: item.line,
    side: item.side,
    ...(item.startLine !== undefined ? { startLine: item.startLine, startSide: item.side } : {}),
    body: item.body,
  }));

  const trimmedBody = args.body?.trim() ?? '';
  return {
    owner: args.owner,
    repo: args.repo,
    number: args.number,
    event: args.event,
    ...(trimmedBody.length > 0 ? { body: trimmedBody } : {}),
    commitSha: args.commitSha,
    ...(comments.length > 0 ? { comments } : {}),
  };
}
