/**
 * Cross-service contract for the code-review publication self-check.
 *
 * The producer (`apps/web` prepare-review-payload) sets this session env var to `'1'` for
 * reviews that publish to the provider. The cloud-agent-next wrapper reads it and, when the
 * agent's turn ends without a successful summary write, asks the agent once to check its work
 * before reporting completion.
 */
export const CODE_REVIEW_PUBLICATION_SELF_CHECK_ENV = 'KILO_CODE_REVIEW_PUBLICATION_SELF_CHECK';
