export function normalizeKilocodeModel(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('kilo/') ? trimmed : `kilo/${trimmed}`;
}

export function dispatchedKilocodeModelId(model: string | undefined | null): string | undefined {
  return normalizeKilocodeModel(model)?.replace(/^kilo\//, '');
}
