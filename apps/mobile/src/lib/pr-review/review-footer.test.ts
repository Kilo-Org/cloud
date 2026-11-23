import { describe, expect, it } from 'vitest';

import { appendReviewFooter, buildReviewFooter } from './review-footer';

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

describe('appendReviewFooter', () => {
  it('submits the trimmed footer alone when the summary is empty', () => {
    // An APPROVE with nothing typed still carries the attribution, and the
    // submitted body has no leading blank lines.
    expect(appendReviewFooter('', 'android')).toBe(buildReviewFooter('android').trim());
    expect(appendReviewFooter('   \n\n', 'android')).toBe(buildReviewFooter('android').trim());
  });

  it('separates a typed summary from the Android footer with one blank line', () => {
    expect(appendReviewFooter('  Summary  \n\n', 'android')).toBe(
      `Summary\n\n---\nReviewed via the [Kilo Android app](${ANDROID_URL})`
    );
  });

  it('appends the trimmed iOS footer for an empty summary', () => {
    expect(appendReviewFooter('', 'ios')).toBe(`---\nReviewed via the [Kilo iOS app](${IOS_URL})`);
  });
});
