import { describe, expect, it } from 'vitest';

import { buildReviewFooter } from './review-footer';

const IOS_URL = 'https://apps.apple.com/app/id6761193135';
const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp';

describe('buildReviewFooter', () => {
  it('builds the iOS footer with the App Store link for the ios platform', () => {
    expect(buildReviewFooter('ios')).toBe(`\n\n---\nReviewed via the [Kilo iOS app](${IOS_URL})`);
  });

  it('builds the Android footer with the Play Store link for the android platform', () => {
    expect(buildReviewFooter('android')).toBe(
      `\n\n---\nReviewed via the [Kilo Android app](${ANDROID_URL})`
    );
  });

  it('builds the Android footer for any non-iOS platform string', () => {
    expect(buildReviewFooter('windows')).toBe(
      `\n\n---\nReviewed via the [Kilo Android app](${ANDROID_URL})`
    );
  });
});
