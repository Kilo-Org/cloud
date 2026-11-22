import { normalizeInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';

export type ProviderDisplayName = Readonly<{ slug: string; displayName: string }>;

/**
 * The display name of every provider in the gateway snapshot, keyed the way a
 * model's `inference_provider_ids` are written.
 *
 * The web catalog page reads the provider snapshot itself, but the mobile app
 * only receives models, so it asks the server for these names and shows each
 * provider exactly as the web page does.
 *
 * Normalizing the slug is what lets the two sides meet: a snapshot provider can
 * be listed as `Google-Vertex` or carry a suffix such as `deepinfra/turbo`,
 * while a model's provider list holds the normalized form, so an unnormalized
 * key would never match. A `null` snapshot means no catalog has been stored yet;
 * the caller then names no providers rather than failing.
 */
export function providerDisplayNames(
  snapshot: { providers: readonly { slug: string; displayName: string }[] } | null
): ProviderDisplayName[] {
  if (!snapshot) return [];

  const namesBySlug = new Map<string, ProviderDisplayName>();
  for (const provider of snapshot.providers) {
    const slug = normalizeInferenceProviderId(provider.slug);
    if (!namesBySlug.has(slug)) {
      namesBySlug.set(slug, { slug, displayName: provider.displayName });
    }
  }

  // Code-unit order, not `localeCompare`, so the list a client renders does not
  // depend on the server's locale.
  return [...namesBySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
