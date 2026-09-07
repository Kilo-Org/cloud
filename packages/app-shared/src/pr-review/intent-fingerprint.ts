/**
 * The single source of truth for the PR operation intent fingerprint.
 *
 * The web router hashes this string into the stored `resource_key`, and the
 * mobile mutation hooks derive the hoisted operation key from it. Both sides
 * MUST produce the same bytes: the stored key is the dedupe identity for the
 * ledger's 30-day retention window, so a drift between the two rotates every
 * in-flight key and makes same-key retries fail with
 * `operation_key_reuse_mismatch`.
 *
 * The `resource` part is provider-split so same-named repos on different
 * providers can never share a retry key:
 * - absent or `'github'` platform: `[owner, repo, number]` — the legacy
 *   bytes, pinned byte-identical so no in-flight GitHub key ever rotates;
 * - `'gitlab'`: `['gitlab', instanceHint ?? '', projectPath, number]`;
 * - `'bitbucket'`: `['bitbucket', workspace, repoSlug, number]`.
 */

import type { ProviderPrPlatform } from '../provider-review/contracts';

export type PrLedgerIntent =
  | 'merge'
  | 'submit_review'
  | 'create_review_comment'
  | 'reply_comment'
  | 'resolve_thread'
  | 'unresolve_thread'
  | 'enable_auto_merge'
  | 'disable_auto_merge';

/**
 * The intent inputs folded into the ledger fingerprint. Any change to one
 * (comment body, review contents, merge method, fence sha, …) yields a
 * different fingerprint, so a key reused for a different request is rejected
 * instead of replaying the old canonical result. Field ORDER is part of the
 * hash — do not reorder. The four thread/auto-merge intents serve the
 * provider review router (GitLab/Bitbucket); the GitHub router never uses
 * them, and the four legacy field lists are byte-frozen.
 */
const PR_FINGERPRINT_FIELDS: Record<PrLedgerIntent, readonly string[]> = {
  create_review_comment: ['body', 'path', 'line', 'side', 'startLine', 'startSide', 'commitSha'],
  reply_comment: ['commentId', 'body'],
  submit_review: ['event', 'body', 'commitSha', 'comments'],
  merge: ['method', 'commitTitle', 'commitMessage', 'deleteBranch', 'expectedHeadSha'],
  resolve_thread: ['threadId'],
  unresolve_thread: ['threadId'],
  enable_auto_merge: ['expectedHeadSha'],
  disable_auto_merge: ['expectedHeadSha'],
};

/**
 * The provider-safe `resource` part of the fingerprint. Field ORDER is part
 * of the hash — do not reorder. The `'gitlab'` / `'bitbucket'` tags are
 * literal array elements, so a GitHub resource can never serialize to the
 * same bytes as a GitLab or Bitbucket one.
 */
function fingerprintResource(input: Record<string, unknown>): readonly unknown[] {
  const platform = input.platform as ProviderPrPlatform | undefined;
  switch (platform) {
    case 'gitlab':
      return ['gitlab', input.instanceHint ?? '', input.projectPath, input.number];
    case 'bitbucket':
      return ['bitbucket', input.workspace, input.repoSlug, input.number];
    default:
      // Absent or 'github': the legacy [owner, repo, number] bytes. Changing
      // these rotates every in-flight GitHub key — do not touch.
      return [input.owner, input.repo, input.number];
  }
}

/**
 * The deterministic fingerprint of one PR intent: the provider-split
 * resource (see `fingerprintResource`) plus the intent-defining fields, in
 * the fixed field order. `JSON.stringify` follows insertion order, so the
 * field list is what keeps the bytes stable across callers that build the
 * input in any order.
 */
export function prIntentFingerprint(
  intent: PrLedgerIntent,
  input: Record<string, unknown>
): string {
  const parts: Record<string, unknown> = { resource: fingerprintResource(input) };
  for (const field of PR_FINGERPRINT_FIELDS[intent]) {
    parts[field] = input[field];
  }
  return JSON.stringify(parts);
}
