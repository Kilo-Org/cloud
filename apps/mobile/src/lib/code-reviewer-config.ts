import {
  type CodeReviewConfigPatch,
  type CodeReviewPlatform,
  type RepositoryModelOverrideInput,
} from '@kilocode/app-shared/code-review';

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { parseParam } from '@/lib/route-params';

export {
  GATE_THRESHOLDS,
  REVIEW_FOCUS_AREAS,
  REVIEW_STYLES,
} from '@kilocode/app-shared/code-review';

export type ReviewerPlatform = CodeReviewPlatform;

export const PERSONAL_SCOPE = 'personal';

export const PLATFORM_CAPABILITIES = {
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
} satisfies Record<
  ReviewerPlatform,
  {
    scopes: 'all' | 'org';
    selectionModePicker: boolean;
    gateRow: boolean;
    reviewMd: boolean;
    manualReview: boolean;
    label: string;
  }
>;

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
 * A route's validated scope+platform combination, as a discriminated union.
 * Personal Bitbucket is impossible (`bitbucket` is org-only per
 * PLATFORM_CAPABILITIES); the `kind: 'personal'` variant carries only
 * `github | gitlab`, so a personal+bitbucket object is not representable.
 */
export type ReviewerScopePlatform =
  | { kind: 'personal'; platform: 'github' | 'gitlab' }
  | { kind: 'org'; organizationId: string; platform: ReviewerPlatform };

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
): ReviewerScopePlatform | null {
  const platform = parseParam(rawPlatform, REVIEWER_PLATFORMS);
  if (!platform) {
    return null;
  }
  if (scope === PERSONAL_SCOPE) {
    // Bitbucket is org-only; a personal-scope Bitbucket route is invalid.
    if (platform === 'bitbucket') {
      return null;
    }
    return { kind: 'personal', platform };
  }
  return { kind: 'org', organizationId: scope, platform };
}

/**
 * Narrows a `ReviewerPlatform` to what the personal procedures accept: the
 * personal router only serves github/gitlab (bitbucket is org-only by UI
 * construction). This must never alias bitbucket to github — a
 * personal+bitbucket argument is a programming error (the route validator
 * rejects it upstream), so it throws rather than silently read or mutate
 * another platform's config.
 */
export function toPersonalPlatform(platform: ReviewerPlatform): 'github' | 'gitlab' {
  if (platform === 'bitbucket') {
    throw new Error('Bitbucket is not available for personal code review');
  }
  return platform;
}

type RouterOutputs = inferRouterOutputs<MobileRouter>;

type PersonalReviewConfig = RouterOutputs['personalReviewAgent']['getReviewConfig'];
type OrgReviewConfig = RouterOutputs['organizations']['reviewAgent']['getReviewConfig'];

// The two getReviewConfig outputs differ only in their id-carrying fields:
// personal GitHub/GitLab ids are numeric, while org Bitbucket ids are UUID
// strings. Every other field is shared. The optimistic cache writes keep a
// single mixed `(number | string)[]` selection (and mixed-id model overrides)
// for both scopes, so derive the union from the router outputs and widen just
// those two fields to the form the cache already uses.
type ReviewConfigIdFields = {
  selectedRepositoryIds: (number | string)[];
  repositoryModelOverrides: RepositoryModelOverrideInput[];
};

export type ReviewConfigData =
  | (Omit<PersonalReviewConfig, keyof ReviewConfigIdFields> & ReviewConfigIdFields)
  | (Omit<OrgReviewConfig, keyof ReviewConfigIdFields> & ReviewConfigIdFields);

// The save/optimistic-cache patch. Kept as the shared app-shared contract so
// the personal and org save paths cannot drift apart.
export type ConfigPatch = CodeReviewConfigPatch;
