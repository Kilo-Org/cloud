export const KILO_MODEL_PREFIX = 'kilo/';

// Removes the outer Kilo gateway prefix, e.g. kilo/openai/gpt-5.5 -> openai/gpt-5.5.
export function unprefixKiloGatewayModelId(model: string): string | undefined {
  if (!model.startsWith(KILO_MODEL_PREFIX)) return undefined;
  const unprefixedModel = model.slice(KILO_MODEL_PREFIX.length);
  return unprefixedModel.includes('/') ? unprefixedModel : undefined;
}

export function deriveModelStatsIdentity(model: string) {
  const modelCreator = model.includes('/') ? model.split('/')[0] : 'unknown';
  return {
    slug: model
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
    modelCreator,
    creatorSlug: modelCreator.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  };
}
