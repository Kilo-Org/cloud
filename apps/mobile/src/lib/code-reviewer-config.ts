import {
  type CodeReviewPlatform,
  type RepositoryModelOverrideInput,
} from '@kilocode/app-shared/code-review';

import { parseParam } from '@/lib/route-params';

export {
  buildSaveConfigInput,
  GATE_THRESHOLDS,
  REVIEW_FOCUS_AREAS,
  REVIEW_STYLES,
} from '@kilocode/app-shared/code-review';

export type ReviewerPlatform = CodeReviewPlatform;

export const PERSONAL_SCOPE = 'personal';

export const PLATFORM_CAPABILITIES: Record<
  ReviewerPlatform,
  {
    scopes: 'all' | 'org';
    selectionModePicker: boolean;
    gateRow: boolean;
    reviewMd: boolean;
    manualReview: boolean;
    label: string;
  }
> = {
  github: {
    scopes: 'all',
    selectionModePicker: true,
    gateRow: true,
    reviewMd: true,
    manualReview: true,
    label: 'GitHub',
  },
  gitlab: {
    scopes: 'all',
    selectionModePicker: false,
    gateRow: true,
    reviewMd: true,
    manualReview: true,
    label: 'GitLab',
  },
  bitbucket: {
    scopes: 'org',
    selectionModePicker: false,
    gateRow: false,
    reviewMd: false,
    manualReview: false,
    label: 'Bitbucket',
  },
};

const REVIEWER_PLATFORMS = Object.keys(PLATFORM_CAPABILITIES) as ReviewerPlatform[];

/**
 * Display label for a code-review platform (e.g. 'github' → 'GitHub'), falling
 * back to the raw value for anything unrecognized. Use this instead of a CSS
 * `capitalize`, which renders 'github' → 'Github'.
 */
export function reviewerPlatformLabel(platform: string): string {
  return REVIEWER_PLATFORMS.includes(platform as ReviewerPlatform)
    ? PLATFORM_CAPABILITIES[platform as ReviewerPlatform].label
    : platform;
}

/**
 * Strictly parses a route's platform segment against the supported
 * scope+platform combinations. Replaces the old `asReviewerPlatform`
 * coercion, which silently fell back to `'github'` for any unrecognized
 * value — so a malformed deep link (e.g. a personal-scope route to
 * Bitbucket, which is org-only per PLATFORM_CAPABILITIES) could end up
 * reading/mutating a different platform's config than the URL claimed.
 * Returns `null` for an unknown platform or an unsupported combination.
 */
export function parseReviewerPlatform(
  scope: string,
  rawPlatform: string | string[] | undefined
): ReviewerPlatform | null {
  const platform = parseParam(rawPlatform, REVIEWER_PLATFORMS);
  if (platform && PLATFORM_CAPABILITIES[platform].scopes === 'org' && scope === PERSONAL_SCOPE) {
    return null;
  }
  return platform;
}

export type ReviewConfigData = {
  isEnabled: boolean;
  reviewStyle: 'strict' | 'balanced' | 'lenient' | 'roast';
  focusAreas: string[];
  customInstructions: string | null;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: 'off' | 'all' | 'warning' | 'critical';
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: (number | string)[];
  repositoryModelOverrides: RepositoryModelOverrideInput[];
  disableReviewMd: boolean;
};

export type ConfigPatch = Partial<{
  reviewStyle: ReviewConfigData['reviewStyle'];
  focusAreas: string[];
  customInstructions: string;
  modelSlug: string;
  thinkingEffort: string | null;
  gateThreshold: ReviewConfigData['gateThreshold'];
  repositorySelectionMode: ReviewConfigData['repositorySelectionMode'];
  selectedRepositoryIds: (number | string)[];
  repositoryModelOverrides: RepositoryModelOverrideInput[];
  disableReviewMd: boolean;
}>;
