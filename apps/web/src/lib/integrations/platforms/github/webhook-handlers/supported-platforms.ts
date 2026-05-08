/**
 * Platforms that surface the PR review decision badge in the cloud-agent-next
 * sidebar. Webhook upserts only run when the tenant has at least one session on
 * a platform in this set for the matching (git_url, branch).
 *
 * Adding a platform here is a one-line change when/if additional UIs need it.
 */
export const REVIEW_DECISION_SUPPORTED_PLATFORMS = [
  'cloud-agent',
  'cloud-agent-web',
  'slack',
] as const;
export type ReviewDecisionSupportedPlatform = (typeof REVIEW_DECISION_SUPPORTED_PLATFORMS)[number];
