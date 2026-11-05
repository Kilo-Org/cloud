/**
 * The manual-review form's platforms, in the order its picker renders them.
 * The URL placeholder and host pattern on the screen, the picker's radio
 * groups, and the start-failure copy all key off this one tuple, so adding a
 * platform is a single edit that the compiler then checks everywhere.
 */
export const MANUAL_REVIEW_PLATFORMS = ['github', 'gitlab'] as const;

export type ManualReviewPlatform = (typeof MANUAL_REVIEW_PLATFORMS)[number];
