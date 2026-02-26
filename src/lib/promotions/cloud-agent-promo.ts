import { isActivePromo, type PromoConfig } from './is-active-promo';

export const CLOUD_AGENT_PROMO_MODEL = 'anthropic/claude-sonnet-4.6';
export const CLOUD_AGENT_PROMO_START = '2026-02-26T08:00:00Z'; // 9am CET (UTC+1)
export const CLOUD_AGENT_PROMO_END = '2026-02-28T08:00:00Z'; // 48h later

const cloudAgentPromoConfig: PromoConfig = {
  sourceField: 'tokenSource',
  sourceValue: 'cloud-agent',
  model: CLOUD_AGENT_PROMO_MODEL,
  start: CLOUD_AGENT_PROMO_START,
  end: CLOUD_AGENT_PROMO_END,
};

function isCloudAgentPromoActive(): boolean {
  const now = Date.now();
  return now >= Date.parse(CLOUD_AGENT_PROMO_START) && now < Date.parse(CLOUD_AGENT_PROMO_END);
}

export function isActiveCloudAgentPromo(tokenSource: string | undefined, model: string): boolean {
  return isActivePromo(cloudAgentPromoConfig, tokenSource, model);
}

export function applyCloudAgentPromoLabel<T extends { id: string; name: string }>(
  options: T[]
): T[] {
  if (!isCloudAgentPromoActive()) return options;
  const endDate = new Date(CLOUD_AGENT_PROMO_END).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
  });
  return options.map(m =>
    m.id === CLOUD_AGENT_PROMO_MODEL ? { ...m, name: `${m.name} (free till ${endDate})` } : m
  );
}
