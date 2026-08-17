/**
 * The single source of truth for the PR operation intent fingerprint.
 *
 * The web router hashes this string into the stored `resource_key`, and the
 * mobile mutation hooks derive the hoisted operation key from it. Both sides
 * MUST produce the same bytes: the stored key is the dedupe identity for the
 * ledger's 30-day retention window, so a drift between the two rotates every
 * in-flight key and makes same-key retries fail with
 * `operation_key_reuse_mismatch`.
 */

export type PrLedgerIntent = 'merge' | 'submit_review' | 'create_review_comment' | 'reply_comment';

/**
 * The intent inputs folded into the ledger fingerprint. Any change to one
 * (comment body, review contents, merge method, fence sha, …) yields a
 * different fingerprint, so a key reused for a different request is rejected
 * instead of replaying the old canonical result. Field ORDER is part of the
 * hash — do not reorder.
 */
const PR_FINGERPRINT_FIELDS: Record<PrLedgerIntent, readonly string[]> = {
  create_review_comment: ['body', 'path', 'line', 'side', 'startLine', 'startSide', 'commitSha'],
  reply_comment: ['commentId', 'body'],
  submit_review: ['event', 'body', 'commitSha', 'comments'],
  merge: ['method', 'commitTitle', 'commitMessage', 'deleteBranch', 'expectedHeadSha'],
};

/**
 * The deterministic fingerprint of one PR intent: the `owner/repo/number`
 * resource plus the intent-defining fields, in the fixed field order.
 * `JSON.stringify` follows insertion order, so the field list is what keeps
 * the bytes stable across callers that build the input in any order.
 */
export function prIntentFingerprint(
  intent: PrLedgerIntent,
  input: Record<string, unknown>
): string {
  const parts: Record<string, unknown> = { resource: [input.owner, input.repo, input.number] };
  for (const field of PR_FINGERPRINT_FIELDS[intent]) {
    parts[field] = input[field];
  }
  return JSON.stringify(parts);
}
