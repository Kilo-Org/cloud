// Pure row-state selection for a recents entry. Extracted so the
// duplicated fallback line (title-less entries printing the identity
// twice) and the failed-entry marker are unit-tested.
//
// Multi-provider identity (s7): the entry's platform decides the identity
// separator (GitLab writes `group/repo!12`, the others `owner/repo#7`) and
// the provider label the row renders, so same-named repositories on
// different providers read as separate rows.

import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';

import { i18n } from '@/i18n';
import { type RecentPr } from '@/lib/pr-review/recent-prs';

export type RecentPrRowState = {
  /** Title when non-empty, else the identity line. */
  primary: string;
  /** The identity line, or null when it would repeat `primary`. */
  secondary: string | null;
  /** True when the entry's last load attempt failed. */
  failed: boolean;
  /** The provider's own name, rendered as the row's badge. */
  provider: string;
};

export function selectRecentPrRowState(entry: RecentPr): RecentPrRowState {
  const platform: ProviderPrPlatform = entry.platform ?? 'github';
  const separator = platform === 'gitlab' ? '!' : '#';
  const identity = `${entry.owner}/${entry.repo}${separator}${entry.number}`;
  const primary = entry.title.length > 0 ? entry.title : identity;
  return {
    primary,
    secondary: primary === identity ? null : identity,
    failed: entry.lastResult === 'failed',
    provider: recentPrProviderLabel(platform),
  };
}

function recentPrProviderLabel(platform: ProviderPrPlatform): string {
  if (platform === 'gitlab') {
    return i18n.t('common.gitlab');
  }
  if (platform === 'bitbucket') {
    return i18n.t('agentChat.repoPicker.platformBitbucket');
  }
  return i18n.t('common.github');
}
