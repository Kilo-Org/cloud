export const KILO_MODEL_PREFIX = 'kilo/';

export function unprefixKiloGatewayModelId(model: string): string | undefined {
  if (!model.startsWith(KILO_MODEL_PREFIX)) return undefined;
  const unprefixedModel = model.slice(KILO_MODEL_PREFIX.length);
  return unprefixedModel.includes('/') ? unprefixedModel : undefined;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function slugifyTrimmed(value: string): string {
  return slugify(value).replace(/^-|-$/g, '');
}

export function deriveModelStatsIdentity(model: string) {
  const modelCreator = model.includes('/') ? model.split('/')[0] : 'unknown';
  return {
    slug: slugifyTrimmed(model),
    modelCreator,
    creatorSlug: slugify(modelCreator),
  };
}
