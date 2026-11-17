/**
 * The explicit capability vocabulary for provider review surfaces.
 *
 * The mobile presentation renders affordances from these flags instead of
 * probing provider endpoints, so an unsupported action degrades to a
 * reason string the UI can show — never to a silent failure.
 *
 * `ProviderReviewCapability` makes the rule structural: the unsupported branch
 * must carry a reason field, and the supported branch cannot carry any copy.
 * The per-provider constants below are the single source of that copy, and
 * they are readonly, so the one shared supported value cannot be rewritten in
 * place through any provider's table.
 */

import type { ProviderPrPlatform } from './contracts';

/** The review events a provider lets a reviewer submit. */
export type ProviderReviewEvent = 'approve' | 'request_changes' | 'comment';

/**
 * A capability that may be absent on a provider. The union makes the rule
 * structural: an unsupported capability MUST carry a human-readable
 * explanation naming the provider (e.g. 'Bitbucket Cloud does not expose
 * auto-merge in its API'), and a supported capability carries no reason.
 */
export type ProviderReviewCapability =
  | { readonly supported: true; readonly reason: '' }
  | { readonly supported: false; readonly reason: string };

/**
 * Every affordance a review surface renders and the data the provider
 * supplies for it. Each affordance is one capability, whether or not any
 * provider lacks it today, so a surface reads `.supported` the same way for
 * all of them.
 */
export type ProviderReviewCapabilities = {
  /** Whether the viewer can post a comment on the PR/MR. */
  readonly canComment: ProviderReviewCapability;
  /** The review events the provider accepts, in display order. */
  readonly reviewEvents: readonly ProviderReviewEvent[];
  /** Whether the viewer can resolve and unresolve discussion threads. */
  readonly canResolveThreads: ProviderReviewCapability;
  /** Whether the viewer can merge the PR/MR at all. */
  readonly canMerge: ProviderReviewCapability;
  /** Whether the provider can merge when its required gates pass later. */
  readonly autoMerge: ProviderReviewCapability;
  /** Whether the provider stores reactions on review comments. */
  readonly reactions: ProviderReviewCapability;
  /** Whether the provider exposes per-reviewer approval states. */
  readonly reviewStatus: ProviderReviewCapability;
};

const SUPPORTED: ProviderReviewCapability = { supported: true, reason: '' };

export const GITHUB_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: SUPPORTED,
  reviewEvents: ['approve', 'request_changes', 'comment'],
  canResolveThreads: SUPPORTED,
  canMerge: SUPPORTED,
  autoMerge: SUPPORTED,
  reactions: SUPPORTED,
  reviewStatus: SUPPORTED,
};

export const GITLAB_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: SUPPORTED,
  reviewEvents: ['approve', 'request_changes', 'comment'],
  canResolveThreads: SUPPORTED,
  canMerge: SUPPORTED,
  autoMerge: SUPPORTED,
  reactions: SUPPORTED,
  reviewStatus: SUPPORTED,
};

export const BITBUCKET_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: SUPPORTED,
  reviewEvents: ['approve', 'request_changes', 'comment'],
  canResolveThreads: SUPPORTED,
  canMerge: SUPPORTED,
  autoMerge: {
    supported: false,
    reason: 'Bitbucket Cloud does not expose auto-merge in its API',
  },
  reactions: {
    supported: false,
    reason: 'Bitbucket Cloud does not expose reactions on pull request comments',
  },
  reviewStatus: SUPPORTED,
};

export const PROVIDER_REVIEW_CAPABILITIES: Record<ProviderPrPlatform, ProviderReviewCapabilities> =
  {
    github: GITHUB_REVIEW_CAPABILITIES,
    gitlab: GITLAB_REVIEW_CAPABILITIES,
    bitbucket: BITBUCKET_REVIEW_CAPABILITIES,
  };

/**
 * The provider-correct term for a code-review object: GitLab calls it a
 * merge request, GitHub and Bitbucket a pull request. User-facing copy MUST
 * build its nouns from this so the wording matches the connected provider.
 */
export function providerPrTerm(platform: ProviderPrPlatform): 'pull request' | 'merge request' {
  return platform === 'gitlab' ? 'merge request' : 'pull request';
}
