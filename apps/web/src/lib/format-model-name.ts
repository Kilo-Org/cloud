import { KILOCODE_KILO_PROVIDER_PREFIX } from '@kilocode/web-shared/lib/ai-gateway/model-utils';

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

/**
 * Strips "Provider: " prefix from a human-readable model display name.
 *
 * - `"Anthropic: Claude Opus 4.6"` → `"Claude Opus 4.6"`
 * - `"Google: Gemini 2.5 Pro"` → `"Gemini 2.5 Pro"`
 * - `"GPT-4o"` (no colon) → `"GPT-4o"`
 * - Empty string → empty string
 */
export function formatShortModelDisplayName(name: string): string {
  if (!name) return name;
  const colonIndex = name.indexOf(': ');
  return colonIndex === -1 ? name : name.slice(colonIndex + 2);
}
