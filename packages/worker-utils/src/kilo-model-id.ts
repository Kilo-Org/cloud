export const KILO_MODEL_PREFIX = 'kilo/';

export function normalizeKiloModelId(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith(KILO_MODEL_PREFIX) ? trimmed : `${KILO_MODEL_PREFIX}${trimmed}`;
}

export function unprefixKiloGatewayModelId(model: string): string | undefined {
  if (!model.startsWith(KILO_MODEL_PREFIX)) return undefined;
  const unprefixedModel = model.slice(KILO_MODEL_PREFIX.length);
  return unprefixedModel.includes('/') ? unprefixedModel : undefined;
}

export function kiloGatewayModelIdCandidates(model: string): string[] {
  const unprefixedModel = unprefixKiloGatewayModelId(model);
  return unprefixedModel ? [model, unprefixedModel] : [model];
}
