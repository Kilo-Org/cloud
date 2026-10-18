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
