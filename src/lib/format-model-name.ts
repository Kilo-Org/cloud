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
  const withoutKilo = slug.startsWith('kilo/') ? slug.slice(5) : slug;
  // Strip provider prefix (everything before and including the first /)
  const slashIndex = withoutKilo.indexOf('/');
  return slashIndex === -1 ? withoutKilo : withoutKilo.slice(slashIndex + 1);
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
