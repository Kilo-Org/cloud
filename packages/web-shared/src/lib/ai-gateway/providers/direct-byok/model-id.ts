/** The `<provider>/` prefix every model id of a direct BYOK provider starts with, lowercase. */
export function modelIdPrefixOf(providerId: string): string {
  return `${providerId.toLowerCase()}/`;
}

/**
 * The canonical `<provider>/<model>` id of a direct BYOK model: the one form the model listing,
 * the model lookup and the exported id lists share.
 */
export function formatModelId(providerId: string, modelId: string): string {
  return modelIdPrefixOf(providerId) + modelId.toLowerCase();
}
