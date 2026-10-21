import { type Href } from 'expo-router';

import { resolveCodeReviewerOpenPrDestination } from '@/lib/code-reviewer-open-pr-destination';
import { openExternalUrl } from '@/lib/external-link';

type FindingLinkRouter = { push: (href: Href) => void };

/**
 * Open a link that came from security-agent finding data.
 *
 * A link that names a supported review (a GitHub pull request, a GitLab merge
 * request, a Bitbucket pull request) navigates to the in-app review route;
 * every other link goes to `openExternalUrl`, which hands `http(s)` to the
 * browser and `mailto:`/`tel:` to the platform handler, and never passes any
 * other scheme to the OS opener.
 */
export function openFindingLink(router: FindingLinkRouter, url: string, label: string): void {
  const destination = resolveCodeReviewerOpenPrDestination(url);
  if (destination.kind === 'in-app') {
    router.push(destination.href);
    return;
  }
  void openExternalUrl(url, { label });
}
