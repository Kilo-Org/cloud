export function normalizeKilocodeModel(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('kilo/') ? trimmed : `kilo/${trimmed}`;
}
