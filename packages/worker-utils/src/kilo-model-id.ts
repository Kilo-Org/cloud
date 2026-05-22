export const KILO_MODEL_PREFIX = 'kilo/';

// Adds the Kilo gateway prefix to provider/model ids; leaves existing kilo/... ids unchanged.
export function normalizeKiloModelId(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith(KILO_MODEL_PREFIX) ? trimmed : `${KILO_MODEL_PREFIX}${trimmed}`;
}

// Removes the outer Kilo gateway prefix, e.g. kilo/openai/gpt-5.5 -> openai/gpt-5.5.
export function unprefixKiloGatewayModelId(model: string): string | undefined {
  if (!model.startsWith(KILO_MODEL_PREFIX)) return undefined;
  const unprefixedModel = model.slice(KILO_MODEL_PREFIX.length);
  return unprefixedModel.includes('/') ? unprefixedModel : undefined;
}
