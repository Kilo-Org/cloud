/**
 * Session env var that opts a code review into the publication self-check. Mirrors
 * `@kilocode/worker-utils/code-review-self-check`, which the producer imports; the wrapper
 * bundle must stay standalone, so it reads this copy instead.
 */
export const CODE_REVIEW_PUBLICATION_SELF_CHECK_ENV = 'KILO_CODE_REVIEW_PUBLICATION_SELF_CHECK';
