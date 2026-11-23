/**
 * The catalog shapes the mobile audits share.
 *
 * Both audits read the same message catalogs: a catalog is a tree of messages,
 * a plural family is a set of keys that differ only by their category suffix,
 * a family may count through `{{count}}`, and only a family with both `_one` and
 * `_other` is complete enough to be owed by every locale. Those are facts about
 * the catalogs, not rules of either gate, so they live here. So is which
 * families a locale must complete before its copy can count: both audits ask
 * that question, so the answer lives here too. So is which plural forms a
 * language can ever render at all. Each audit keeps its own allowlists,
 * wording and exit behavior, including what it does with a key that is not a
 * plural category.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { regularFileState } from './fs-entries.mjs';

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
 * The kind of a `.json`-named entry of `dir`: 'file' names a regular file,
 * 'unreadable' an entry stat cannot follow (stat threw), and 'other' an
 * entry that exists but is not a regular file, such as a directory named
 * like a catalog.
 *
 * The follow-symlink decision itself is `regularFileState`'s, shared with the
 * source walk, so the two audits cannot disagree on what a file is.
 */
export function catalogEntryKind(dir, name) {
  return regularFileState(join(dir, name));
}

/**
 * The `.json`-named entries of `dir`, sorted, without the `.json` extension,
 * leaving out every entry whose `catalogEntryKind` is `excludedKind`.
 *
 * The two readers of a catalog folder reject a different kind on purpose: the
 * tag set keeps an entry it cannot stat, so the audit's own later read reports
 * the problem, while the membership rule names such an entry as a stray.
 */
export function catalogEntryNames(dir, excludedKind) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      entry => entry.name.endsWith('.json') && catalogEntryKind(dir, entry.name) !== excludedKind
    )
    .map(entry => entry.name.replace(/\.json$/, ''))
    .sort();
}

/**
 * The locale tags on disk in `dir`, sorted, without the `.json` extension.
 *
 * The tag's path must name a regular file, following symlinks: a directory
 * named like a catalog is not a catalog, and reading it as one would end the
 * audit in a stack trace, while a symlink to a real catalog audits like the
 * file it names. An entry stat cannot follow is kept as a tag anyway,
 * deliberately: the audit's own later read of that path reports the problem.
 */
export function catalogTags(dir) {
  return catalogEntryNames(dir, 'other');
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
 * The plural categories a catalog of `tag` can ever render: every category
 * `Intl.PluralRules` selects, plus `zero`, which i18next looks up on its own at
 * count 0 before it asks the plural rule (i18next's `resolve()` pushes
 * `<key>_zero` into the lookup candidates when `count === 0`), so a `_zero`
 * form renders in every language.
 *
 * Any other category is unreachable: i18next picks its suffix from
 * `rule.select(count)` alone, so a form outside this set is copy no user of
 * that language can see.
 */
export function selectablePluralCategories(tag) {
  return new Set([...new Intl.PluralRules(tag).resolvedOptions().pluralCategories, 'zero']);
}

/**
 * The plural forms a locale declares whose category it can never select, by
 * family base, in catalog order: a Map from the family base to the categories,
 * in key order, that `tag` cannot reach.
 *
 * The walk is over the locale's own keys, so a family is judged by the member
 * forms the catalog actually ships rather than by what English declares. A
 * family whose every member is selectable is absent from the Map, so an empty
 * Map means every plural form of this locale renders somewhere.
 */
export function unselectablePluralCategories(locale, tag) {
  const selectable = selectablePluralCategories(tag);
  const unselectable = new Map();
  for (const key of locale.keys()) {
    const parts = pluralParts(key);
    if (parts === null || selectable.has(parts.category)) {
      continue;
    }
    const declared = unselectable.get(parts.base);
    if (declared === undefined) {
      unselectable.set(parts.base, [parts.category]);
    } else {
      declared.push(parts.category);
    }
  }
  return unselectable;
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

/**
 * The categories a locale lacks, by family base, for every family it must
 * complete: a Map from the family base to the categories the tag selects that
 * the locale does not carry, in the tag's category order.
 *
 * A family the locale declares itself — a member key with a category suffix —
 * must carry every category its tag selects, whatever English ships. A family
 * English declares and every locale owes (`familiesOwedByEveryLocale`) is
 * mandatory when the locale carries the family's flat base key, and then every
 * category the tag selects must be present. Every other family is not this
 * locale's problem: a locale that lacks an owed family's base key is a
 * key-parity finding, not a category finding.
 *
 * A complete family is absent from the Map, so an empty Map means the locale is
 * complete. Both audits ask this question, so the answer lives here and neither
 * audit carries the rule.
 */
export function missingPluralCategories(english, locale, tag) {
  const required = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
  const owed = familiesOwedByEveryLocale(english);
  const localeFamilies = pluralFamilyBases(locale);
  const missing = new Map();
  for (const family of new Set([...pluralFamilyBases(english), ...localeFamilies])) {
    const mandatory = localeFamilies.has(family) || (owed.has(family) && locale.has(family));
    if (!mandatory) {
      continue;
    }
    const absent = required.filter(category => !locale.has(`${family}_${category}`));
    if (absent.length > 0) {
      missing.set(family, absent);
    }
  }
  return missing;
}
