import {
  type SubmitReviewComment,
  type SubmitReviewInput,
} from '@/lib/pr-review/use-pr-review-mutations';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

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
 * `submitReview` tRPC input. The submission always uses the latest head SHA;
 * queued `commitSha` values are only used for the "may be outdated" hint.
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
