// PR-review attribution footer appended to the review summary when the
// default-on preference is enabled. The input is the running platform's OS,
// so iOS gets the iOS App Store link and every other platform (Android
// included) gets the Play Store link.

const IOS_APP_URL = 'https://apps.apple.com/app/id6761193135';
const ANDROID_APP_URL = 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp';

export function buildReviewFooter(os: 'ios' | 'android' | string): string {
  if (os === 'ios') {
    return `\n\n---\nReviewed via the [Kilo iOS app](${IOS_APP_URL})`;
  }
  return `\n\n---\nReviewed via the [Kilo Android app](${ANDROID_APP_URL})`;
}

// The footer is appended at submit, not seeded into the summary field: the
// field starts empty, so a reader never edits around attribution they did not write.
export function appendReviewFooter(summary: string, os: 'ios' | 'android' | string): string {
  const typed = summary.trim();
  const footer = buildReviewFooter(os).trim();
  return typed.length > 0 ? `${typed}\n\n${footer}` : footer;
}
