import { isActivePromo, type PromoConfig } from './is-active-promo';

export const KILOCLAW_PROMO_MODEL = 'moonshotai/kimi-k2.5';
export const KILOCLAW_PROMO_START = '2026-03-04T00:00:00Z'; // midnight Wednesday UTC
export const KILOCLAW_PROMO_END = '2026-03-11T00:00:00Z'; // 1 week

const kiloClawPromoConfig: PromoConfig = {
  sourceField: 'tokenSource',
  sourceValue: 'claw',
  model: KILOCLAW_PROMO_MODEL,
  start: KILOCLAW_PROMO_START,
  end: KILOCLAW_PROMO_END,
};

export function isActiveKiloClawPromo(tokenSource: string | undefined, model: string): boolean {
  return isActivePromo(kiloClawPromoConfig, tokenSource, model);
}
