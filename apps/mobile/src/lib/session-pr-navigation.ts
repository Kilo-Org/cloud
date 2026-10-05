import { type Href } from 'expo-router';

import { parseProviderPrUrl } from '@/lib/pr-review/provider-pr-url';
import { providerPrRoutePath } from '@/lib/pr-review/provider-pr-ref';

export type SessionPrNavigationInput = Readonly<{
  /** PR/MR HTML URL, e.g. `https://github.com/org/repo/pull/123`. */
  url: string | null | undefined;
}>;

export type SessionPrNavigationResult =
  | { kind: 'in-app'; href: Href }
  | { kind: 'browser'; url: string };

/**
 * Decide where tapping a session's PR badge navigates.
 *
 * A GitHub pull request, a GitLab merge request (gitlab.com or a
 * self-managed host) and a Bitbucket pull request all open the in-app
 * provider review route through the one URL resolver — the badge's own
 * platform decides the route, so a GitLab MR never lands on a GitHub-shaped
 * identity. Only a genuinely unparseable URL (GitHub Enterprise, a docs
 * link, a bare number) falls back to the browser.
 */
export function resolveSessionPrTapTarget(
  input: SessionPrNavigationInput
): SessionPrNavigationResult {
  const url = input.url;
  const ref = url ? parseProviderPrUrl(url) : null;

  if (ref) {
    return { kind: 'in-app', href: providerPrRoutePath(ref) };
  }
  return { kind: 'browser', url: url ?? '' };
}

/**
 * Press-time variant of `resolveSessionPrTapTarget` that also honors the
 * PR-review kill switch, so a session long-press or a context-sheet tap lands
 * in the same place as the PR badge and chat links. The flag module is imported
 * lazily so hosts that never press a PR (and the mounted tests' node
 * environment) never load the native analytics client, and the flag is read
 * once at press time rather than subscribed to.
 */
export async function resolveSessionPrPressTarget(
  input: SessionPrNavigationInput
): Promise<SessionPrNavigationResult> {
  const { FEATURE_FLAG_PR_REVIEW, isFeatureFlagEnabled } = await import('@/lib/analytics/posthog');
  if (!isFeatureFlagEnabled(FEATURE_FLAG_PR_REVIEW, true)) {
    return { kind: 'browser', url: input.url ?? '' };
  }
  return resolveSessionPrTapTarget(input);
}
