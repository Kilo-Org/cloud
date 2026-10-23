export const KILO_MODEL_PREFIX = 'kilo/';

/** `undefined` unless the remainder after `kilo/` still contains a `/`. */
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
