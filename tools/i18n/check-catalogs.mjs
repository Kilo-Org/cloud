#!/usr/bin/env node
/**
 * Catalog parity check.
 *
 * Every translated catalog must be a key-for-key copy of the English one, and
 * every key the source uses must exist. This runs in CI, so a locale can never
 * drift from English without the build saying so.
 *
 * The value checks are mechanical, so they hold for a language nobody here
 * reads: placeholders, `$t(key)` references, edge spacing, double spaces and
 * direction marks must match English, and a message must never quote an
 * English button label in place of the reader's own.
 *
 * Usage: node tools/i18n/check-catalogs.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const LANGUAGES_FILE = join(ROOT, 'apps/mobile/src/i18n/languages.ts');
const SOURCE_DIRS = [join(ROOT, 'apps/mobile/src')];
const CATALOGS = [
  { name: 'mobile', dir: join(ROOT, 'apps/mobile/src/i18n/locales'), checkUsage: true },
  {
    name: 'notifications',
    dir: join(ROOT, 'packages/notifications/src/locales'),
    checkUsage: false,
  },
];

const problems = [];
const fail = message => problems.push(message);

/**
 * English strings a catalog is allowed to render more than one way, because
 * its grammar forces the difference — a counter form, a plural stem, a verb
 * where English reuses the noun. Everything else must read the same way
 * everywhere in one catalog.
 */
const WORDING_EXCEPTIONS = JSON.parse(
  readFileSync(join(ROOT, 'tools/i18n/wording-exceptions.json'), 'utf8')
);

/**
 * Proper nouns, format-only strings, and pre-existing English-identical copy
 * outside this section's five keys. Remove a key from the set when that copy
 * is translated or the key is deleted.
 */
const ENGLISH_IDENTICAL_ALLOWLIST = new Set([
  'profile.providerAnaconda',
  'profile.providerApple',
  'profile.providerDiscord',
  'profile.providerGithub',
  'profile.providerGitlab',
  'profile.providerGoogle',
  'profile.providerLinkedin',
  'kiloclaw.status.vcpuValue',
  'securityAgent.findingDetails.cve',
  'securityAgent.findingDetails.ghsa',
  'securityAgent.findingDetails.sourceDependabot',
  'agentChat.toolCard.toolBash',
  'agentChat.toolCard.toolGlob',
  'agentChat.toolCard.toolGrep',
  'agentChat.modelCost.perMillion',
  'agentChat.questionCard.option',
  'agentChat.sessionFilter.platformCli',
  'agentChat.sessionFilter.platformSlack',
  'agentChat.sessionFilter.platformGithub',
  'agentChat.sessionFilter.platformLinear',
  'agentChat.repoPicker.platformGithub',
  'agentChat.repoPicker.platformGitlab',
  'agentChat.prBadge.label',
  'home.noLiveSessions',
  'share.reviewPrSubtitle',
  // Format-only strings with no translatable words: a placeholder-only screen
  // title and a placeholder-plus-UTC time-range label.
  'prReview.screen.title',
  'securityAgent.auditReport.periodUtc',
]);

/** The supported tags, read from the one source of truth. */
function supportedLanguages() {
  const source = readFileSync(LANGUAGES_FILE, 'utf8');
  const block = /export const SUPPORTED_LANGUAGES = \[([^\]]*)\]/.exec(source);
  if (!block) {
    throw new Error('SUPPORTED_LANGUAGES not found in languages.ts');
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}

/**
 * Parse a catalog and report a key that appears twice in one object. JSON.parse
 * keeps the last duplicate silently, so the raw text is the only witness.
 */
function parseCatalog(file, label) {
  const text = readFileSync(file, 'utf8');
  const seen = [];
  JSON.parse(text, function reviver(key, value) {
    return value;
  });
  // Walk the raw text: a duplicate key inside one object survives only here.
  const stack = [new Set()];
  const tokens = text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:|[{}]/g);
  for (const token of tokens) {
    if (token[0] === '{') {
      stack.push(new Set());
    } else if (token[0] === '}') {
      stack.pop();
    } else {
      const key = token[1];
      const scope = stack.at(-1);
      if (scope.has(key)) {
        seen.push(key);
      }
      scope.add(key);
    }
  }
  for (const key of seen) {
    fail(`${label}: duplicate key "${key}"`);
  }
  return JSON.parse(text);
}

function flatten(value, prefix = '', out = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, out);
    } else {
      out.set(path, String(child));
    }
  }
  return out;
}

/** The `{{token}}` set of one string, as a sorted, counted signature. */
function placeholders(value) {
  return [...value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)]
    .map(match => match[1])
    .sort()
    .join(',');
}

/** The `$t(key)` set of one string. A copy names a label; it never spells it. */
function nestingRefs(value) {
  return [...value.matchAll(/\$t\(\s*([^)\s,]+)\s*\)/g)].map(match => match[1]).sort();
}

/** The leading and trailing whitespace of one string, as a signature. */
function edges(value) {
  return JSON.stringify([/^\s*/.exec(value)[0], /\s*$/.exec(value)[0]]);
}

const QUOTE_PAIRS = [
  ['\u201c', '\u201d'],
  ['\u201e', '\u201c'],
  ['\u201e', '\u201d'],
  ['\u201e', '"'],
  ['\u00ab', '\u00bb'],
  ['\u00bb', '\u00ab'],
  ['\u2018', '\u2019'],
  ['\u201a', '\u2018'],
  ['\u201a', '\u2019'],
  ['[', ']'],
  ['\u300c', '\u300d'],
  ['\u300e', '\u300f'],
  ['\uff62', '\uff63'],
  ['\u2039', '\u203a'],
  ['\u300a', '\u300b'],
  ['"', '"'],
];
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every quoted run short enough to name a control. A translator who spells a
 * button label instead of naming its key leaves the run here, where the
 * English-label check below can see it.
 */
function quotedRuns(value) {
  const runs = new Set();
  for (const [open, close] of QUOTE_PAIRS) {
    const pattern = new RegExp(
      `${escapeRegExp(open)}([^${escapeRegExp(close)}\n]{2,60})${escapeRegExp(close)}`,
      'gu'
    );
    for (const match of value.matchAll(pattern)) {
      runs.add(match[1].trim());
    }
  }
  for (const match of value.matchAll(/(?:^|[\s(:>\p{L}])'([^'\n]{2,60})'/gu)) {
    runs.add(match[1].trim());
  }
  return [...runs].filter(
    run => /\p{L}/u.test(run) && !/\{\{/.test(run) && run.split(/\s+/).length <= 6
  );
}

/**
 * Whether this catalog keeps `run` as a label of its own. A product name the
 * catalog does not translate sits in a value barely longer than the name, so
 * quoting it is right. A label the catalog does translate has no such value,
 * and quoting the English one names a control the user never sees.
 */
function holdsLabel(values, run) {
  for (const value of values) {
    if (value.length <= run.length + 6 && value.includes(run)) {
      return true;
    }
  }
  return false;
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        sourceFiles(path, out);
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Two sets:
 * - `called`: keys passed to t() or i18n.t() as a plain string. Each must exist.
 * - `referenced`: every string literal in the source. A key named in a lookup
 *   table and passed to t() through a variable is used, so the dead-key check
 *   reads this wider set and never asks anyone to delete a live key.
 */
function scanSource() {
  const called = new Set();
  const referenced = new Set();
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\b(?:i18n\.)?t\(\s*'([^']+)'/g)) {
        called.add(match[1]);
      }
      // `*`, not `+`: an empty '' must consume both quotes, or the scan pairs
      // its closing quote with the next string's opening quote and desyncs.
      for (const match of text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
        const literal = match[1] ?? match[2];
        if (literal !== '') {
          referenced.add(literal);
        }
      }
      // A template-literal key would make the both-ways check unsound.
      if (/\b(?:i18n\.)?t\(\s*`/.test(text)) {
        fail(`${file}: t() called with a template literal; the key check cannot see it`);
      }
    }
  }
  return { called, referenced };
}

/**
 * The scripts one catalog may write in. Latin rides along everywhere for
 * product names and abbreviations; every other script must be the catalog's
 * own. A catalog that mixes two alphabets reads as two different languages —
 * Serbian shipped Latin copy beside Cyrillic strays for exactly that reason.
 */
const SCRIPT_PATTERNS = {
  Latin: /\p{Script=Latin}/u,
  Cyrillic: /\p{Script=Cyrillic}/u,
  Arabic: /\p{Script=Arabic}/u,
  Greek: /\p{Script=Greek}/u,
  Hebrew: /\p{Script=Hebrew}/u,
  Devanagari: /\p{Script=Devanagari}/u,
  Han: /\p{Script=Han}/u,
  Hangul: /\p{Script=Hangul}/u,
  Hiragana: /\p{Script=Hiragana}/u,
  Katakana: /\p{Script=Katakana}/u,
  Thai: /\p{Script=Thai}/u,
  Armenian: /\p{Script=Armenian}/u,
  Georgian: /\p{Script=Georgian}/u,
  Bengali: /\p{Script=Bengali}/u,
  Tamil: /\p{Script=Tamil}/u,
  Telugu: /\p{Script=Telugu}/u,
  Gujarati: /\p{Script=Gujarati}/u,
  Gurmukhi: /\p{Script=Gurmukhi}/u,
  Kannada: /\p{Script=Kannada}/u,
  Malayalam: /\p{Script=Malayalam}/u,
  Oriya: /\p{Script=Oriya}/u,
  Sinhala: /\p{Script=Sinhala}/u,
  Myanmar: /\p{Script=Myanmar}/u,
  Khmer: /\p{Script=Khmer}/u,
  Lao: /\p{Script=Lao}/u,
  Ethiopic: /\p{Script=Ethiopic}/u,
};

/** Languages whose own orthography needs more than one script. */
const MULTI_SCRIPT_LANGUAGES = { ja: ['Hiragana', 'Katakana', 'Han'] };

function scriptOf(char) {
  for (const [name, pattern] of Object.entries(SCRIPT_PATTERNS)) {
    if (pattern.test(char)) {
      return name;
    }
  }
  return null;
}

/** Every script in `values`, counted, so the dominant one can be picked. */
function scriptCounts(values) {
  const counts = new Map();
  for (const value of values) {
    for (const char of value) {
      const name = scriptOf(char);
      if (name) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/** Fold a value for wording comparison: case, edge space and end punctuation. */
function wording(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!:。！：]+$/u, '');
}

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

function pluralBaseKey(key) {
  return key.replace(/_(?:zero|one|two|few|many|other)$/, '');
}

/** Split a dotted key into its family base and plural category, if any. */
function pluralParts(key) {
  const match = PLURAL_SUFFIX_RE.exec(key);
  if (!match) {
    return null;
  }
  return { base: key.slice(0, -match[0].length), category: match[1] };
}

const tags = supportedLanguages();

for (const catalog of CATALOGS) {
  const present = readdirSync(catalog.dir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace(/\.json$/, ''));

  for (const tag of tags) {
    if (!present.includes(tag)) {
      fail(`${catalog.name}: no catalog for supported language "${tag}"`);
    }
  }
  for (const tag of present) {
    if (!tags.includes(tag)) {
      fail(`${catalog.name}: catalog "${tag}.json" is not a supported language`);
    }
  }

  const english = flatten(parseCatalog(join(catalog.dir, 'en.json'), `${catalog.name}/en`));
  const englishFamilies = new Set(
    [...english.keys()]
      .map(pluralParts)
      .filter(Boolean)
      .map(parts => parts.base)
  );
  const englishValues = new Set(english.values());
  // Keys whose English text is identical. Short strings only: a long sentence
  // repeated verbatim is rare, and a 60-character cap keeps the groups to the
  // labels and messages where one wording actually matters.
  const wordingGroups = new Map();
  for (const [key, value] of english) {
    if (value.length < 2 || value.length > 60) {
      continue;
    }
    const folded = wording(value);
    if (!wordingGroups.has(folded)) {
      wordingGroups.set(folded, []);
    }
    wordingGroups.get(folded).push(key);
  }
  const sharedWordings = [...wordingGroups].filter(([, keys]) => keys.length > 1);
  for (const [key, value] of english) {
    if (value.trim() === '') {
      fail(`${catalog.name}/en: "${key}" is empty`);
    }
    for (const ref of nestingRefs(value)) {
      if (!english.has(ref)) {
        fail(`${catalog.name}/en: "${key}" names $t(${ref}), which en.json does not define`);
      }
    }
    // English must not spell a label it can name, or every translator copies
    // the English word into a sentence they otherwise translated.
    for (const run of quotedRuns(value)) {
      if (englishValues.has(run)) {
        fail(`${catalog.name}/en: "${key}" quotes the label "${run}"; name its key with $t()`);
      }
    }
  }

  const localeValues = new Map();

  for (const tag of present) {
    if (tag === 'en') {
      continue;
    }
    const label = `${catalog.name}/${tag}`;
    const translated = flatten(parseCatalog(join(catalog.dir, `${tag}.json`), label));
    localeValues.set(tag, translated);
    const ownValues = new Set(translated.values());

    for (const key of english.keys()) {
      if (!translated.has(key)) {
        fail(`${label}: missing key "${key}"`);
      }
    }
    for (const key of translated.keys()) {
      if (english.has(key)) {
        continue;
      }
      const parts = pluralParts(key);
      if (!(parts && englishFamilies.has(parts.base))) {
        fail(`${label}: extra key "${key}" is not in en.json`);
      }
    }
    const requiredCategories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
    for (const family of englishFamilies) {
      for (const category of requiredCategories) {
        if (!translated.has(`${family}_${category}`)) {
          fail(`${label}: plural family "${family}" lacks the ${category} category of ${tag}`);
        }
      }
    }
    for (const [key, value] of translated) {
      if (english.has(key)) {
        continue;
      }
      const parts = pluralParts(key);
      if (!(parts && englishFamilies.has(parts.base))) {
        continue;
      }
      const englishRef =
        english.get(`${parts.base}_${parts.category}`) ??
        english.get(`${parts.base}_other`) ??
        english.get(parts.base);
      const allowed = new Set(placeholders(englishRef).split(',').filter(Boolean));
      for (const ph of placeholders(value).split(',').filter(Boolean)) {
        if (!allowed.has(ph)) {
          fail(`${label}: "${key}" uses placeholder {{${ph}}}, which the English family does not`);
        }
      }
    }
    for (const [key, value] of translated) {
      if (!english.has(key)) {
        continue;
      }
      if (value.trim() === '') {
        fail(`${label}: "${key}" is empty`);
      }
      const englishValue = english.get(key);
      const expected = placeholders(englishValue);
      if (placeholders(value) !== expected) {
        fail(`${label}: "${key}" placeholders differ from English (${expected || 'none'})`);
      }
      const expectedRefs = nestingRefs(englishValue).join(',');
      if (nestingRefs(value).join(',') !== expectedRefs) {
        fail(`${label}: "${key}" $t() references differ from English (${expectedRefs || 'none'})`);
      }
      if (edges(value) !== edges(englishValue)) {
        fail(`${label}: "${key}" leading or trailing space differs from English`);
      }
      if (/ {2}/.test(value) && !/ {2}/.test(englishValue)) {
        fail(`${label}: "${key}" has a double space`);
      }
      if (/[\u200e\u200f\u202a-\u202e]/.test(value)) {
        fail(`${label}: "${key}" carries a direction mark; write plain text`);
      }
      // A quoted English label. The copy must name the label's key with
      // `$t(key)`, or the message points at a button this user never sees.
      for (const run of quotedRuns(value)) {
        if (englishValues.has(run) && !holdsLabel(ownValues, run)) {
          fail(`${label}: "${key}" quotes the English label "${run}"; name its key with $t()`);
        }
      }
    }

    // One alphabet per catalog.
    const counts = scriptCounts(translated.values());
    const allowed = new Set(MULTI_SCRIPT_LANGUAGES[tag] ?? []);
    if (allowed.size === 0) {
      // The catalog's own script is its largest non-Latin one, but only when
      // it carries a real share of the letters. Latin rides along in every
      // catalog through product names and placeholders, so a bare "most
      // frequent" rule would call a short Korean catalog Latin — while a
      // Latin catalog holding a handful of Cyrillic look-alike letters (a
      // Cyrillic "а" inside a Latin word) would adopt Cyrillic and pass.
      const letters = [...counts.values()].reduce((sum, n) => sum + n, 0);
      const [own] = [...counts]
        .filter(([name, n]) => name !== 'Latin' && n >= letters * 0.05)
        .sort((a, b) => b[1] - a[1])[0] ?? ['Latin'];
      allowed.add(own);
    }
    allowed.add('Latin');
    const strayScripts = [...counts.keys()].filter(name => !allowed.has(name));
    if (strayScripts.length > 0) {
      const examples = [...translated]
        .filter(([, value]) => [...value].some(char => strayScripts.includes(scriptOf(char))))
        .slice(0, 3)
        .map(([key]) => key);
      fail(
        `${label}: writes ${strayScripts.join(' and ')} beside ${[...allowed].join(' and ')} (e.g. ${examples.join(', ')}); keep one alphabet`
      );
    }

    // One wording per English string.
    const exceptions = new Set(WORDING_EXCEPTIONS[tag] ?? []);
    for (const [source, keys] of sharedWordings) {
      if (exceptions.has(source)) {
        continue;
      }
      const variants = new Map();
      for (const key of keys) {
        const value = translated.get(key);
        if (value === undefined) {
          continue;
        }
        const folded = wording(value);
        if (!variants.has(folded)) {
          variants.set(folded, key);
        }
      }
      if (variants.size > 1) {
        const shown = [...variants].map(([value, key]) => `"${value}" (${key})`).join(' vs ');
        fail(
          `${label}: English "${source}" is translated ${variants.size} ways: ${shown}. Pick one, or list the English string in tools/i18n/wording-exceptions.json under "${tag}".`
        );
      }
    }
  }

  // A mobile key whose value equals English in every non-English locale was
  // never translated. Allowlist the proper nouns and format-only strings that
  // are legitimately identical; fail everything else.
  if (catalog.name === 'mobile') {
    for (const [key, englishValue] of english) {
      if (ENGLISH_IDENTICAL_ALLOWLIST.has(key)) {
        continue;
      }
      let allEqual = true;
      for (const tag of present) {
        if (tag === 'en') {
          continue;
        }
        if (localeValues.get(tag).get(key) !== englishValue) {
          allEqual = false;
          break;
        }
      }
      if (allEqual) {
        fail(`mobile: "${key}" equals English in every locale`);
      }
    }
  }

  if (catalog.checkUsage) {
    const { called, referenced } = scanSource();
    for (const key of called) {
      if (!english.has(key)) {
        fail(`${catalog.name}: source uses "${key}", which en.json does not define`);
      }
    }
    for (const key of english.keys()) {
      if (!referenced.has(key) && !referenced.has(pluralBaseKey(key))) {
        fail(`${catalog.name}: en.json defines "${key}", which no source file uses`);
      }
    }
  }
}

if (problems.length > 0) {
  const limit = Number(process.env.I18N_CHECK_LIMIT ?? '50');
  const shown = problems.slice(0, limit);
  for (const problem of shown) {
    console.error(problem);
  }
  if (problems.length > shown.length) {
    console.error(`... and ${problems.length - shown.length} more`);
  }
  console.error(`\ncheck-catalogs: ${problems.length} problem(s)`);
  process.exit(1);
}

console.log(`check-catalogs: ${tags.length} languages, every catalog matches en.json`);
