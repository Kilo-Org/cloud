export const REVIEW_PROMO_MODEL = 'anthropic/claude-sonnet-4.6';
export const REVIEW_PROMO_END = '2026-02-25T14:00:00Z';

export function isActiveReviewPromo(botId: string | undefined, model: string): boolean {
  if (botId !== 'reviewer') return false;
  if (model !== REVIEW_PROMO_MODEL) return false;
  return Date.now() < Date.parse(REVIEW_PROMO_END);
}
