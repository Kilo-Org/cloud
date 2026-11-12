/**
 * The catalog shapes the mobile audits share.
 *
 * Both audits read the same message catalogs: a catalog is a tree of messages,
 * a plural family is a set of keys that differ only by their category suffix,
 * and a family may count through `{{count}}`. Those are facts about the
 * catalogs, not rules of either gate, so they live here. Each audit keeps its
 * own allowlists, wording and exit behavior, including what it does with a key
 * that is not a plural category.
 */

/** The plural categories i18next selects from, as they end a catalog key. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** i18next's own count variable, which selects the plural category. */
const COUNT_PLACEHOLDER = /{{\s*count\s*}}/;

/** Split a dotted key into its family base and plural category, if any. */
export function pluralParts(key) {
  const match = PLURAL_SUFFIX.exec(key);
  if (!match) {
    return null;
  }
  return { base: key.slice(0, -match[0].length), category: match[1] };
}

/**
 * Flatten a catalog to dotted keys. A leaf is any value that is not a plain
 * object, so a nested message and an array message both land on their own key.
 */
export function flattenCatalog(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenCatalog(child, path, out);
    } else {
      out.set(path, String(child));
    }
  }
  return out;
}

/**
 * The base key of every message whose copy counts through `{{count}}`.
 *
 * i18next reads the plural category from that variable, so a family built from
 * it can be accepted as one flat string per locale: a locale whose wording
 * inflects no word renders the same string at every count. A message that
 * carries no `{{count}}` gets no such fallback. `messages` is a flattened
 * catalog, and a key that is not a category maps to itself.
 */
export function countPlaceholderBases(messages) {
  return new Set(
    [...messages]
      .filter(([, value]) => COUNT_PLACEHOLDER.test(value))
      .map(([key]) => pluralParts(key)?.base ?? key)
  );
}
