/**
 * The explicit capability vocabulary for provider review surfaces.
 *
 * The mobile presentation renders affordances from these flags instead of
 * probing provider endpoints, so an unsupported action degrades to a
 * reason string the UI can show — never to a silent failure.
 *
 * Invariant: every `supported: false` capability carries a human-readable
 * provider reason. The per-provider constants below are the single source
 * of that copy.
 */

import type { ProviderPrPlatform } from './contracts';

/** The review events a provider lets a reviewer submit. */
export type ProviderReviewEvent = 'approve' | 'request_changes' | 'comment';

/**
 * A capability that may be absent on a provider. When `supported` is false,
 * `reason` MUST hold a human-readable explanation naming the provider
 * (e.g. 'Bitbucket Cloud does not expose auto-merge in its API'); when
 * supported, `reason` is ''.
 */
export type ProviderReviewCapability = {
  supported: boolean;
  reason: string;
};

export type ProviderReviewCapabilities = {
  /** Whether the viewer can post a comment on the PR/MR. */
  canComment: boolean;
  /** The review events the provider accepts, in display order. */
  reviewEvents: ProviderReviewEvent[];
  canResolveThreads: boolean;
  canMerge: boolean;
  autoMerge: ProviderReviewCapability;
  reactions: ProviderReviewCapability;
  /** Whether the provider exposes per-reviewer approval states. */
  reviewStatus: ProviderReviewCapability;
};

const SUPPORTED: ProviderReviewCapability = { supported: true, reason: '' };

export const GITHUB_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: true,
  reviewEvents: ['approve', 'request_changes', 'comment'],
  canResolveThreads: true,
  canMerge: true,
  autoMerge: SUPPORTED,
  reactions: SUPPORTED,
  reviewStatus: SUPPORTED,
};

export const GITLAB_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: true,
  reviewEvents: ['approve', 'request_changes', 'comment'],
  canResolveThreads: true,
  canMerge: true,
  autoMerge: SUPPORTED,
  reactions: SUPPORTED,
  reviewStatus: SUPPORTED,
};

export const BITBUCKET_REVIEW_CAPABILITIES: ProviderReviewCapabilities = {
  canComment: true,
  reviewEvents: ['approve', 'request_changes', 'comment'],
  canResolveThreads: true,
  canMerge: true,
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
