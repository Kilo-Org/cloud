/**
 * Shared model utilities that can be used on both client and server.
 * Keep this file free of server-only dependencies.
 */

/**
 * Normalize a model ID by removing the `:free`, `:exacto`, etc. suffixes if present.
 */
export function normalizeModelId(modelId: string): string {
  const colonIndex = modelId.indexOf(':');
  return colonIndex >= 0 ? modelId.substring(0, colonIndex) : modelId;
}
