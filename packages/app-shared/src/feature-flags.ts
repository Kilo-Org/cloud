/**
 * PostHog feature flag keys that more than one app evaluates.
 *
 * The web app, the AI gateway and the mobile app all read one PostHog project,
 * so a key spelled once here is what keeps the same person's rollout decision
 * identical everywhere. A client-specific copy of a key is the failure this
 * module removes: one character off and the surface silently loses its gate.
 *
 * Flag keys are public identifiers, not secrets; the PostHog project key and
 * host are configured per app.
 */

/**
 * The only literal source of the cross-app flag keys. The constants below
 * alias its members, and `FeatureFlagKey` derives from it, so a key added here
 * is present in both without a second edit.
 */
export const CROSS_APP_FEATURE_FLAG_KEYS = {
  codeReviewMdConversion: 'code-review-md-conversion',
  codeReviewCouncil: 'code-review-council',
  organizationAutoModel: 'organization-auto-model-routing',
  chatGptSignIn: 'sign-in-with-chatgpt',
} as const satisfies Record<string, string>;

/**
 * Custom Instructions → REVIEW.md conversion (route plus the UI button that
 * opens it). A credit-spending, PR-opening action, so it is staged behind a
 * flag and doubles as a kill switch. Server: `isFeatureFlagEnabledOrDevelopment`.
 */
export const CODE_REVIEW_MD_CONVERSION_FLAG = CROSS_APP_FEATURE_FLAG_KEYS.codeReviewMdConversion;

/**
 * Code review council UI for entitled enterprise organizations (staged
 * rollout). Gates the council configuration surfaces; a review that already
 * has a persisted council result renders it regardless of this flag.
 */
export const CODE_REVIEW_COUNCIL_FLAG = CROSS_APP_FEATURE_FLAG_KEYS.codeReviewCouncil;

/**
 * Organization auto model routing: the org's default routing policy and the
 * "Auto" default model in organization settings.
 */
export const ORGANIZATION_AUTO_MODEL_FLAG = CROSS_APP_FEATURE_FLAG_KEYS.organizationAutoModel;

/**
 * The OpenAI (ChatGPT subscription) BYOK connection card and the entries that
 * lead to it. The flag's release condition holds the approved email domains, so
 * it needs a person. "Continue with ChatGPT" sign-in itself is not gated.
 */
export const CHATGPT_ACCESS_FLAG = CROSS_APP_FEATURE_FLAG_KEYS.chatGptSignIn;

/**
 * Every flag key this repository evaluates in more than one app.
 *
 * Derived from `CROSS_APP_FEATURE_FLAG_KEYS`: a key added to that object is in
 * this union, where a hand-written list could fall behind it.
 */
export type FeatureFlagKey =
  (typeof CROSS_APP_FEATURE_FLAG_KEYS)[keyof typeof CROSS_APP_FEATURE_FLAG_KEYS];
