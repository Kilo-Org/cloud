export const KILO_MODEL_PREFIX = 'kilo/';

// Removes the outer Kilo gateway prefix, e.g. kilo/openai/gpt-5.5 -> openai/gpt-5.5.
export function unprefixKiloGatewayModelId(model: string): string | undefined {
  if (!model.startsWith(KILO_MODEL_PREFIX)) return undefined;
  const unprefixedModel = model.slice(KILO_MODEL_PREFIX.length);
  return unprefixedModel.includes('/') ? unprefixedModel : undefined;
}
