/**
 * Normalize a model ID by removing the `:free`, `:exacto`, etc. suffixes if present.
 */
export function normalizeModelId(modelId: string): string {
  const colonIndex = modelId.indexOf(':');
  return colonIndex >= 0 ? modelId.substring(0, colonIndex) : modelId;
}
