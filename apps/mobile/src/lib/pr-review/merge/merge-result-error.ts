// Typed error thrown by the PR merge sheet when the server's
// `mergePullRequest` procedure returns a non-success result. The server
// only treats `merged: true` as a real merge — anything else (e.g. a 405
// "not mergeable" reply where `response.data.merged === false`) must NOT
// be celebrated as a success.
//
// This class intentionally does NOT expose a tRPC `data.code` so the
// existing `classifyPrReviewMutationError` falls through to the
// retryable branch (sheet stays open, submit re-enabled, inline error).
// Routing it through the BAD_REQUEST branch would disable the submit
// button and lock the user out of retrying.

export class MergeNotCompletedError extends Error {
  /** The sha GitHub reported in the merge response, when available. */
  readonly sha?: string;
  /** Optional human-readable reason from the server (e.g. "not mergeable"). */
  readonly reason?: string;

  constructor(args: { message?: string; sha?: string; reason?: string } = {}) {
    super(args.message ?? 'GitHub did not complete the merge.');
    this.name = 'MergeNotCompletedError';
    this.sha = args.sha;
    this.reason = args.reason;
  }
}
