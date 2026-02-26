export const CLOUD_AGENT_PROMO_MODEL = 'anthropic/claude-sonnet-4.6';
export const CLOUD_AGENT_PROMO_START = '2026-02-26T08:00:00Z'; // 9am CET (UTC+1)
export const CLOUD_AGENT_PROMO_END = '2026-02-28T08:00:00Z'; // 48h later

function isCloudAgentPromoActive(): boolean {
  const now = Date.now();
  return now >= Date.parse(CLOUD_AGENT_PROMO_START) && now < Date.parse(CLOUD_AGENT_PROMO_END);
}

export function isActiveCloudAgentPromo(tokenSource: string | undefined, model: string): boolean {
  if (tokenSource !== 'cloud-agent') return false;
  if (model !== CLOUD_AGENT_PROMO_MODEL) return false;
  return isCloudAgentPromoActive();
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
