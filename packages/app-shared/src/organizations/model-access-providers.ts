/**
 * The canonical form of one inference provider slug: trimmed, cut at the first
 * `/` so a model-shaped entry names its provider, and lowercased. This module
 * is the single source of that rule; the web-shared `inference-provider-id`
 * module re-exports it for the web and gateway paths, so one stored value means
 * the same provider whatever wrote it.
 */
export function normalizeInferenceProviderId(providerId: string): string {
  const trimmed = providerId.trim();
  const slashIndex = trimmed.indexOf('/');
  return (slashIndex >= 0 ? trimmed.slice(0, slashIndex) : trimmed).toLowerCase();
}

/**
 * The canonical form of an allow list of provider slugs: each entry through
 * `normalizeInferenceProviderId`, entries that name no provider dropped, and
 * the first occurrence of a slug kept. Order is preserved.
 */
export function normalizeInferenceProviderIds(providerIds: readonly string[]): string[] {
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const providerId of providerIds) {
    const normalized = normalizeInferenceProviderId(providerId);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    canonical.push(normalized);
  }
  return canonical;
}
