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
 * The name a model reference is shown as, resolved through the catalog the
 * matching picker reads (`useAvailableModels`).
 *
 * A briefing report and its estimate store the gateway id the summary ran with,
 * so printing them verbatim put `~deepseek/deepseek-flash-latest` under the
 * summary text while the briefing settings picker showed the same model as
 * `DeepSeek Flash Latest`. Copy never prints a raw reference: a reference the
 * catalog does not carry (offline, cold cache, retired model) falls back to its
 * last path segment with hyphens as spaces, without the `~` latest-alias marker.
 */
export function resolveCatalogModelName(model: string, catalog: readonly NamedModel[]): string {
  const option = catalog.find(item => item.id === model);
  if (option) {
    return option.name;
  }
  const reference = formatShortModelDisplayName(model);
  const segment = reference.slice(reference.lastIndexOf('/') + 1).replace(/^~/, '');
  return segment.replaceAll(/-+/g, ' ').trim() || reference;
}
