export function normalizeModelId(modelId: string): string {
  const colonIndex = modelId.indexOf(':');
  return colonIndex >= 0 ? modelId.substring(0, colonIndex) : modelId;
}
