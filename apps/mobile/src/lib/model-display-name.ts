/**
 * Strip the `Vendor: ` prefix from a human-readable model display name.
 *
 * Gateway and CLI catalog names arrive as `<Vendor>: <Model>`, and the model
 * picker already shows the vendor as its group header. Mirrors
 * `formatShortModelDisplayName` in the web app.
 *
 * - `"DeepSeek: DeepSeek V4 Flash 0731"` → `"DeepSeek V4 Flash 0731"`
 * - `"GPT-4o"` (no colon) → `"GPT-4o"`
 * - `""` → `""`
 */
export function formatShortModelDisplayName(name: string): string {
  if (!name) {
    return name;
  }
  const colonIndex = name.indexOf(': ');
  return colonIndex === -1 ? name : name.slice(colonIndex + 2);
}

/** The catalog fields a model reference is resolved against. */
type NamedModel = { readonly id: string; readonly name: string };

/**
 * The name a raw model reference is shown as when the catalog does not carry
 * it: its last path segment, without the `~` latest-alias marker and with
 * hyphens as spaces.
 *
 * - `"deepseek/deepseek-v4.1-flash-1017"` → `"deepseek v4.1 flash 1017"`
 * - `"~deepseek/deepseek-v4-flash-latest"` → `"deepseek v4 flash latest"`
 * - `"custom-model-id"` → `"custom model id"`
 */
function formatModelReferenceName(reference: string): string {
  const segment = reference.slice(reference.lastIndexOf('/') + 1).replace(/^~/, '');
  const words = segment.replaceAll(/-+/g, ' ').trim();
  return words === '' ? reference : words;
}

/**
 * The label the model chip shows for a stored value no catalog row matched:
 * the `Vendor: ` display prefix stripped, and for a `vendor/model` id the
 * readable last segment (see `formatModelReferenceName`).
 *
 * A value is treated as a reference — and rewritten — when it still carries a
 * `/` or a leading `~` latest-alias marker. Anything else is already a name, so
 * the chip keeps it unchanged (`custom-model-id` → `custom-model-id`) and
 * `~kilo-auto` becomes `kilo auto` rather than printing the alias marker.
 *
 * `resolveCatalogModelName` deliberately does not use this gate: a briefing
 * report or a session model stores an id whose segments are always readable,
 * so that resolver formats every unmatched value.
 */
export function modelReferenceLabel(reference: string): string {
  const shortName = formatShortModelDisplayName(reference);
  return shortName.includes('/') || shortName.startsWith('~')
    ? formatModelReferenceName(shortName)
    : shortName;
}

/**
 * The name a model reference is shown as, resolved through the catalog the
 * matching picker reads (`useAvailableModels`).
 *
 * A briefing report and its estimate store the gateway id the summary ran with,
 * so printing them verbatim put `~deepseek/deepseek-flash-latest` under the
 * summary text while the briefing settings picker showed the same model as
 * `DeepSeek Flash Latest`. Copy never prints a raw reference: a reference the
 * catalog does not carry (offline, cold cache, retired model) falls back to
 * the form `formatModelReferenceName` describes.
 */
export function resolveCatalogModelName(model: string, catalog: readonly NamedModel[]): string {
  const option = catalog.find(item => item.id === model);
  if (option) {
    return option.name;
  }
  const reference = formatModelReferenceName(formatShortModelDisplayName(model));
  return reference || model;
}
