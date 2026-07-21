import { describe, expect, it } from 'vitest';

import {
  PR_REVIEW_TRUNCATION_BANNER_THRESHOLD,
  shouldShowTruncationBanner,
  truncationBannerCopy,
} from './pr-review-truncation';

describe('pr-review-truncation', () => {
  it('hides the banner when changedFiles is at the threshold', () => {
    expect(shouldShowTruncationBanner(PR_REVIEW_TRUNCATION_BANNER_THRESHOLD)).toBe(false);
  });

  it('hides the banner when changedFiles is below the threshold', () => {
    expect(shouldShowTruncationBanner(0)).toBe(false);
    expect(shouldShowTruncationBanner(2999)).toBe(false);
  });

  it('shows the banner when changedFiles is above the threshold', () => {
    expect(shouldShowTruncationBanner(3001)).toBe(true);
    expect(shouldShowTruncationBanner(10_000)).toBe(true);
  });

  it('renders the banner copy with the threshold + the actual file count', () => {
    expect(truncationBannerCopy(3001)).toBe(
      'Showing the first 3,000 of 3,001 changed files — GitHub API limit'
    );
    expect(truncationBannerCopy(12_345)).toBe(
      'Showing the first 3,000 of 12,345 changed files — GitHub API limit'
    );
  });
});
