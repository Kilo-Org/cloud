import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

export type ModelPricing = { prompt?: string; completion?: string };

function formatSide(pricePerTokenStr: string | undefined): string | null {
  if (pricePerTokenStr === undefined) {
    return null;
  }

  const pricePer1M = Number.parseFloat(pricePerTokenStr) * 1_000_000;
  if (!Number.isFinite(pricePer1M) || pricePer1M <= 0) {
    return null;
  }

  if (pricePer1M < 0.01) {
    return `<${formatNumber(0.01, i18n.language, {
      style: 'currency',
      currency: 'USD',
    })}`;
  }

  return formatNumber(pricePer1M, i18n.language, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

/** Visible per-1M-token cost for picker rows. null = hide the cost line. */
export function formatModelCostPer1M(pricing: ModelPricing | undefined): string | null {
  if (!pricing) {
    return null;
  }

  const input = formatSide(pricing.prompt);
  const output = formatSide(pricing.completion);
  if (input === null || output === null) {
    return null;
  }

  const million = formatNumber(1_000_000, i18n.language, { notation: 'compact' });
  return `${i18n.t('agentChat.messageDetails.input')} ${input} · ${i18n.t(
    'agentChat.messageDetails.output'
  )} ${output} / ${million} ${i18n.t('agentChat.contextUsage.tokens')}`;
}

/** Row-level cost decision: free/BYOK badges suppress cost; otherwise format. */
export function modelPickerCostLabel(option: {
  isFree?: boolean;
  hasUserByokAvailable?: boolean;
  pricing?: ModelPricing;
}): string | null {
  if (option.isFree === true || option.hasUserByokAvailable === true) {
    return null;
  }
  return formatModelCostPer1M(option.pricing);
}
