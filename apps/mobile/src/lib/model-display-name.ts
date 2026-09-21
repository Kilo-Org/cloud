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
