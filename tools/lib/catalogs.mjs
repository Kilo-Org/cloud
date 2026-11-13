/**
 * The catalog shapes the mobile audits share.
 *
 * Both audits read the same message catalogs: a catalog is a tree of messages,
 * a plural family is a set of keys that differ only by their category suffix,
 * a family may count through `{{count}}`, and only a family with both `_one` and
 * `_other` is complete enough to be owed by every locale. Those are facts about
 * the catalogs, not rules of either gate, so they live here. Each audit keeps
 * its own allowlists, wording and exit behavior, including what it does with a
 * key that is not a plural category.
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

/**
 * The base key of every plural family a catalog declares, in catalog order.
 *
 * A key that ends in a category is a member of a family whatever the other
 * members are, so this set is every base the catalog names — it is not the set
 * of complete families, and a key-parity rule must use it as is: a locale that
 * declares one member of an English family must not read its other siblings as
 * extra keys.
 */
export function pluralFamilyBases(messages) {
  const bases = new Set();
  for (const key of messages.keys()) {
    const parts = pluralParts(key);
    if (parts) {
      bases.add(parts.base);
    }
  }
  return bases;
}

/**
 * Whether a catalog declares a plural family for `base`. English needs the
 * `_one` and `_other` categories, so a family is complete only when both are
 * present.
 */
export function declaresPluralFamily(messages, base) {
  return messages.has(`${base}_one`) && messages.has(`${base}_other`);
}

/**
 * The families every locale owes the categories its own plural rules require.
 *
 * A family English declares is owed, unless English builds its copy from
 * `{{count}}` — the variable that is the count. Those families were accepted
 * with the flat-key fallback: a locale whose wording inflects no word keeps the
 * one string and renders it at every count, so it owes no categories until it
 * declares a member itself. A family built from `{{displayCount}}` or
 * `{{itemCount}}` carries the caller's formatted number instead and gets no such
 * fallback.
 */
export function familiesOwedByEveryLocale(english) {
  const numeralFamilies = countPlaceholderBases(english);
  return new Set(
    [...pluralFamilyBases(english)].filter(
      family => declaresPluralFamily(english, family) && !numeralFamilies.has(family)
    )
  );
}
