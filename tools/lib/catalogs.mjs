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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

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
 * The FormatJS data file each mobile language loads, read from the app's own
 * loader map, so a language that maps to a shared file (`zh-Hans` and `zh-Hant`
 * both read `zh`) or to another language's data (`ht` reads `en`) is judged by
 * exactly what it loads.
 */
const LOADER_MAP_SOURCE = 'apps/mobile/src/lib/formatjs-locale-data.ts';
const LOADER_MAP_ENTRY =
  /^\s*(?:'([^']+)'|([A-Za-z-]+)):\s*\(\) => void require\('@formatjs\/intl-pluralrules\/locale-data\/([^']+)\.js'\)/gm;

/** The polyfill data directory, below the app's own dependency tree. */
const PLURAL_DATA_DIR = 'apps/mobile/node_modules/@formatjs/intl-pluralrules/locale-data';

/** The loader map read from one repository root, parsed once per audit. */
const loaderMaps = new Map();

/** The category lists already read, per root and tag. */
const shippedCategoryCache = new Map();

function loaderMapOf(root) {
  if (loaderMaps.has(root)) {
    return loaderMaps.get(root);
  }
  let source;
  try {
    source = readFileSync(join(root, LOADER_MAP_SOURCE), 'utf8');
  } catch {
    // A tree without the app at all (a checker test fixture) has no polyfill
    // data to read, so the caller falls back to the host's rules.
    loaderMaps.set(root, null);
    return null;
  }
  const block = /const PLURAL_RULES_LOCALE_LOADERS = \{([\s\S]*?)\n\} satisfies/.exec(source);
  if (block === null) {
    // The app is here but its loader map is not, so the language-to-data-file
    // mapping this rule depends on is gone. Falling back to the host's rules
    // would audit the catalogs against data the app does not run, which is the
    // silent wrong answer this rule exists to prevent.
    throw new Error(`${LOADER_MAP_SOURCE} declares no PLURAL_RULES_LOCALE_LOADERS map`);
  }
  const map = new Map();
  for (const match of block[1].matchAll(LOADER_MAP_ENTRY)) {
    map.set(match[1] ?? match[2], match[3]);
  }
  if (map.size === 0) {
    // The block is there but no entry in it reads as a data-file loader, so a
    // quote or syntax change has silently emptied the map. Treating that as
    // "no app data" would audit every language against the host's rules, the
    // silent wrong answer this rule exists to prevent.
    throw new Error(`${LOADER_MAP_SOURCE} declares no readable plural-data loader`);
  }
  loaderMaps.set(root, map);
  return map;
}

/**
 * The cardinal categories one FormatJS data file declares. The file is the
 * generated module the polyfill itself evaluates: it calls
 * `Intl.PluralRules.__addLocaleData` when that exists, and otherwise buffers
 * its data on `globalThis`. A sandbox with no `__addLocaleData` takes the
 * second path, so the file's own code says what the data is rather than a
 * second parser here.
 *
 * The sandbox is local to this call: only the category names leave it, so no
 * context outlives the read that needed it.
 */
function readPluralDataFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `${file} is missing: this audit reads the plural data the app bundle ships, so install the app's dependencies before running it`
    );
  }
  const sandbox = { Intl: { PluralRules: undefined } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 2000 });
  const data = sandbox.__FORMATJS_PLURALRULES_DATA__;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`no plural data in ${file}`);
  }
  return [...data[0].data.categories.cardinal];
}

/**
 * The cardinal categories `tag` can select in the runtime that renders the
 * mobile catalogs: the app's shipped FormatJS data, because Hermes has no
 * `Intl.PluralRules` of its own and the bundle's polyfill data therefore
 * decides the suffix.
 *
 * The host's `Intl.PluralRules` is NOT that answer. The two disagree — a host
 * on a newer CLDR reads `vi` as `other`-only while the shipped data still
 * selects `one` for a count of one — so judging by the host would call
 * reachable Vietnamese copy dead. A tree without the app's loader map (a
 * checker fixture, or a catalog the polyfill does not render) falls back to
 * the host's rules.
 */
export function shippedPluralCategories(root, tag) {
  const key = `${root}\u0000${tag}`;
  const cached = shippedCategoryCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const dataFile = loaderMapOf(root)?.get(tag);
  const categories =
    dataFile === undefined
      ? new Intl.PluralRules(tag).resolvedOptions().pluralCategories
      : readPluralDataFile(join(root, PLURAL_DATA_DIR, `${dataFile}.js`));
  shippedCategoryCache.set(key, categories);
  return categories;
}

/**
 * The plural categories a catalog of `tag` can ever render: the categories the
 * runtime selects, plus `zero`, which i18next looks up on its own at count 0
 * before it asks the plural rule (`resolve()` pushes `<key>_zero` into the
 * lookup candidates when `count === 0`), so a `_zero` form renders in every
 * language.
 *
 * Any other category is unreachable: i18next picks its suffix from
 * `rule.select(count)` alone, so a form outside this set is copy no user of
 * that language can see.
 */
export function selectablePluralCategories(root, tag) {
  return new Set([...shippedPluralCategories(root, tag), 'zero']);
}

/**
 * The plural forms a locale declares whose category the runtime never selects
 * AND whose copy is identical to the family's `other` form, by family base:
 * a Map from the family base to the categories, in key order.
 *
 * `selectable` is the category set the rendering runtime answers with, so the
 * caller decides what "selectable" means for the catalog it audits. The copy
 * test is what makes a report act on proof rather than on a rule: a form whose
 * text equals its family's `other` text renders exactly the same string whether
 * `other` or this form answers, under any plural rule, so removing it cannot
 * change what a reader sees. A form with text of its own is left alone, because
 * the runtime that renders it may not be the one the audit measured.
 *
 * `zero` is never reported: i18next consults that suffix directly at count 0, so
 * no plural rule can say it is unreachable.
 *
 * A family with no unproven form is absent from the Map, so an empty Map means
 * every plural form of this locale is either reachable or distinct copy.
 */
export function unselectablePluralCategories(locale, selectable) {
  const unselectable = new Map();
  for (const key of locale.keys()) {
    const parts = pluralParts(key);
    if (parts === null || parts.category === 'zero' || selectable.has(parts.category)) {
      continue;
    }
    const other = locale.get(`${parts.base}_other`);
    if (other === undefined || other !== locale.get(key)) {
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
 *
 * `requiredCategories` is the category list the caller judges the catalog by.
 * It defaults to the host's `Intl.PluralRules`, which is right for a catalog a
 * Worker renders. A caller whose copy renders somewhere else — the mobile app
 * bundles its own plural data — passes that runtime's list, so the categories
 * it requires and the categories it forbids are the same set. Two rules reading
 * two different plural sources can contradict each other: one demands a form
 * the other rejects.
 */
export function missingPluralCategories(english, locale, tag, requiredCategories) {
  const required =
    requiredCategories ?? new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
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
