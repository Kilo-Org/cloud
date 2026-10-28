import { KILOCODE_KILO_PROVIDER_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';

export { formatShortModelDisplayName } from '@kilocode/app-shared/utils';

/**
 * Strips provider prefixes from a model slug to produce a short display name.
 *
 * - `kilo/anthropic/claude-sonnet-4` → `claude-sonnet-4`
 * - `anthropic/claude-sonnet-4` → `claude-sonnet-4`
 * - `claude-sonnet-4` (no slash) → `claude-sonnet-4`
 * - Empty string → empty string
 */
export function formatShortModelName(slug: string): string {
  if (!slug) return slug;
  // Strip kilo/ prefix first
  const withoutKilo = slug.startsWith(KILOCODE_KILO_PROVIDER_PREFIX)
    ? slug.slice(KILOCODE_KILO_PROVIDER_PREFIX.length)
    : slug;
  // Strip provider prefix (everything before and including the first /)
  const slashIndex = withoutKilo.indexOf('/');
  return slashIndex === -1 ? withoutKilo : withoutKilo.slice(slashIndex + 1);
}

/**
 * Formats a `{ providerID, modelID }` ref into a short display name.
 *
 * - `{ providerID: 'kilo', modelID: 'anthropic/claude-opus-4.6' }` → `claude-opus-4.6`
 * - `{ providerID: 'anthropic', modelID: 'claude-sonnet-4' }` → `claude-sonnet-4`
 */
export function formatModelRefName(model: { providerID: string; modelID: string }): string {
  return formatShortModelName(`${model.providerID}/${model.modelID}`);
}
