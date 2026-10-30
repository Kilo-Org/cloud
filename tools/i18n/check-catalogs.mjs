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
 * English strings this product uses in two senses, so each sense needs a key.
 *
 * Every other piece of copy belongs to exactly one key. Two keys holding the
 * same English string drift apart the moment someone translates one of them,
 * and nothing downstream can tell which of the two the reader was meant to see.
 *
 * The value records why the split is real. Adding an entry claims the call sites
 * mean different things; removing one promises the copy means the same thing
 * everywhere it appears.
 */
const TWO_SENSE_COPY = new Map([
  [
    'open',
    'the verb on a button and an alert action, versus the state of a pull request, a finding and an invoice',
  ],
  ['comment', 'the verb on a button, versus the noun on a row label and a badge'],
  ['block', 'the verb, block a discussion participant, versus the reviewer decision to block'],
  ['merge', 'the verb in the merge section header, versus the name of the merge method on a badge'],
  ['review', 'the noun, a review, versus the verb in the onboarding step'],
  ['high', 'the severity of a finding, versus the thinking effort of a model'],
  ['medium', 'the severity of a finding, versus the thinking effort of a model'],
  ['low', 'the severity of a finding, versus the thinking effort of a model'],
  [
    'manual review',
    'the suggested action for a security finding, versus the manual-review pull request feature',
  ],
  [
    'cancelled',
    'a state badge on a cancelled run or cancellation request, versus the audit timeline event that remediation was cancelled',
  ],
  [
    'deleted',
    'the state of a draft or item after deletion, versus the audit timeline event that a finding was deleted',
  ],
  [
    'dismissed',
    'the state of a finding or notification, versus the audit timeline event that a finding was dismissed',
  ],
  [
    'remediation requested',
    'the remediation timeline row on a finding, versus the audit report timeline event',
  ],
  [
    'remediation failed',
    'the remediation timeline row on a finding, versus the audit report timeline event',
  ],
  [
    'remediation blocked',
    'the remediation timeline row on a finding, versus the audit report timeline event',
  ],
  [
    'superseded',
    'the deadline badge naming a replaced finding, versus the audit timeline event that a finding was superseded',
  ],
  [
    'analysis failed',
    'the analysis state headline on a finding, versus the audit timeline event that an analysis failed',
  ],
  [
    'pr opened',
    'the remediation status row on a finding, versus the audit timeline event that a remediation PR was opened',
  ],
  [
    'no changes needed',
    'the remediation status row on a finding, versus the audit timeline event that remediation found no changes',
  ],
  ['none', 'no review gate, versus the thinking effort of a model'],
  ['files', 'the files in a pull request, versus the iOS Files app in the attachment picker'],
  ['plan', 'a billing plan, versus the agent plan mode'],
  ['copied', 'a file copied in a diff, versus the toast after a copy to the clipboard'],
]);

/**
 * Counted forms that say their number as a word instead of the visible count
 * placeholder, as `base key:plural category:locale`. Arabic names one day and
 * two days with their own word forms, so those two messages read as words and
 * carry no numeral. Every other form of a counted family must keep its
 * language's exact placeholder set, so a count deleted from a form that should
 * show it still fails. Add an entry only after reading the rendered message.
 */
const WORDED_COUNTS = new Set([
  'securityAgent.dashboard.daysOverdue:one:ar',
  'securityAgent.dashboard.daysOverdue:two:ar',
]);

/**
 * Proper nouns, format-only strings, and pre-existing English-identical copy
 * outside this section's new keys. Remove a key from the set when that copy
 * is translated or the key is deleted.
 */
const ENGLISH_IDENTICAL_ALLOWLIST = new Set([
  'profile.providerAnaconda',
  'profile.providerApple',
  'profile.providerDiscord',
  'common.github',
  'common.gitlab',
  'profile.providerGoogle',
  'profile.providerLinkedin',
  'consent.kilo',
  'common.kiloclaw',
  'tabs.kiloclawWrapped',
  'kiloclaw.status.vcpuValue',
  'securityAgent.findingDetails.cve',
  'securityAgent.findingDetails.ghsa',
  'securityAgent.findingDetails.sourceDependabot',
  'agentChat.toolCard.toolBash',
  'agentChat.toolCard.toolGlob',
  'agentChat.toolCard.toolGrep',
  'agentChat.modelCost.perMillion',
  'agentChat.tasks.progress',
  'agentChat.questionCard.option',
  'agentChat.sessionFilter.platformCli',
  'agentChat.sessionFilter.platformSlack',
  'agentChat.sessionFilter.platformLinear',
  'agentChat.repoPicker.platformBitbucket',
  'agentChat.prBadge.label',
  // Profile-editor examples that name the value's own syntax, not prose: a
  // slug the field validator accepts, a server name, a JSON snippet, and
  // command lines whose tool and package paths must stay literal. Every
  // catalog keeps them English so the example never contradicts validation.
  'profiles.mcp.namePlaceholder',
  'profiles.mcp.commandPlaceholder',
  'profiles.mcp.jsonPlaceholder',
  'profiles.agents.slugPlaceholder',
  // The sampling parameter's published name. `Top P` is what the provider docs
  // and every model dashboard call this knob, so no locale translates it — a
  // translated word would hide which parameter the field sets.
  'profiles.agents.topP',
  'profiles.slashCommands.namePlaceholder',
  'profiles.slashCommands.agentPlaceholder',
  // The skills.sh source label. It names the published site the skill is
  // installed from, so every catalog keeps the site's own spelling.
  'profiles.skillSourceSkillsSh',
  // The MCP count label. `MCP` is the protocol's own acronym, so every catalog
  // keeps the same "{{count}} MCP" the MCP-server rows use.
  'profiles.counts.mcp',
  // The inference protocols keep their published API names across locales.
  'modelChat.backends.chatCompletions',
  'modelChat.backends.responses',
  'modelChat.backends.messages',
  'share.reviewPrSubtitle',
  // Format-only strings with no translatable words: a placeholder-only screen
  // title, a placeholder-plus-UTC time-range label, and a pure $t() reference
  // that names the transcription-model section title.
  'prReview.screen.title',
  'securityAgent.auditReport.periodUtc',
  'preferences.transcriptionModel',
  // Pure $t() references in the tour: they name another key's label, so every
  // locale resolves them to its own translation through i18next nesting.
  'tour.cloudOptionTitle',
  // A placeholder-only accessibility label: the list's name and its open
  // counter joined by a comma, so a catalog may keep English punctuation.
  'todos.lists.rowA11y',
  // Format-only briefing values: a lower-bound marker and a time range built
  // from localized placeholders, with no translatable words.
  'agentBriefing.atLeast',
  'agentBriefing.window',
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

/**
 * The agent editor's three visibility options each read `label — description`.
 * A catalog that separates one option with an en dash, a hyphen, a colon, or no
 * space at all draws one radio group in three shapes, and the reader has to
 * compare the labels to see that they are the same kind of thing.
 */
const VISIBILITY_KEYS = [
  'profiles.agents.visibilityPrimary',
  'profiles.agents.visibilitySubagent',
  'profiles.agents.visibilityAll',
];

/**
 * Agent-editor labels that read the same in every catalog, aside from the
 * separator shape above: `profiles.agents.topP` is the sampling parameter's
 * published name, so a translated word would hide which parameter the field
 * sets. The allowlist exempts the key from the "equals English everywhere"
 * failure; this is the positive requirement that replaces it.
 */
const VERBATIM_KEYS = ['profiles.agents.topP'];

function checkVerbatimLabels(values, english, label) {
  for (const key of VERBATIM_KEYS) {
    const value = values.get(key);
    const reference = english.get(key);
    if (value !== undefined && reference !== undefined && value !== reference) {
      fail(`${label}: "${key}" must read "${reference}" in every catalog`);
    }
  }
}

function checkVisibilitySeparators(values, label) {
  for (const key of VISIBILITY_KEYS) {
    const value = values.get(key);
    if (value !== undefined && value.split(' — ').length !== 2) {
      fail(`${label}: "${key}" must join its label and description with " — "`);
    }
  }
}

/** The agent editor's catalog rules, applied to English and to every locale. */
function checkAgentEditorCopy(values, english, label) {
  checkVisibilitySeparators(values, label);
  checkVerbatimLabels(values, english, label);
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

/**
 * The `$TOKEN` expansion tokens of one string, e.g. `$ARGUMENTS`. Kilo expands
 * these literally, so a translator who spells one out (or translates it) leaves
 * the reader with a token nothing replaces. The set must match English.
 */
function expansionTokens(value) {
  return [...value.matchAll(/\$[A-Z][A-Z0-9_]*/g)].map(match => match[0]).sort();
}

/** The leading and trailing whitespace of one string, as a signature. */
function edges(value) {
  return JSON.stringify([/^\s*/.exec(value)[0], /\s*$/.exec(value)[0]]);
}

/**
 * Keys whose surrounding whitespace is the sentence's own separator rather than
 * part of a word. The login screen joins `login.termsPrefix` straight to its
 * Terms link and puts `login.termsConnector` between the two links, so the
 * separator belongs to the locale: a catalog that separates words with a space
 * keeps that space in the value, and Chinese abuts the segments. Every other
 * key keeps English's edges exactly.
 */
const LOCALE_SEPARATED_KEYS = new Set(['login.termsPrefix', 'login.termsConnector']);

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
function wording(value, language = 'en') {
  return value
    .trim()
    .toLocaleUpperCase(language)
    .toLocaleLowerCase(language)
    .replace(/[.!:。！：]+$/u, '');
}

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

function pluralBaseKey(key) {
  return key.replace(/_(?:zero|one|two|few|many|other)$/, '');
}

/**
 * The visible-count placeholders an English family declares, e.g.
 * `displayCount`. A translated form must carry each one unless a reviewed
 * worded form spells the number out instead.
 */
function familyVisibleCounts(english, base) {
  const names = new Set();
  for (const [key, value] of english) {
    if (key !== base && pluralBaseKey(key) !== base) {
      continue;
    }
    for (const name of placeholders(value).split(',').filter(Boolean)) {
      if (name === 'displayCount' || name === 'itemCount') {
        names.add(name);
      }
    }
  }
  return names;
}

/** Split a dotted key into its family base and plural category, if any. */
function pluralParts(key) {
  const match = PLURAL_SUFFIX_RE.exec(key);
  if (!match) {
    return null;
  }
  return { base: key.slice(0, -match[0].length), category: match[1] };
}

/**
 * Every `{{token}}` an English plural family uses, across the base key and all
 * of its categories. A language may need one of those tokens in a category
 * where English spells the number out: English's `_one` only ever renders at 1,
 * but Serbian, Croatian, Bosnian, Russian, Ukrainian, Belarusian, Macedonian,
 * Lithuanian, Latvian, Icelandic, Filipino and Slovene also select their
 * singular form for 21, 101 and the like, so their `_one` value has to
 * interpolate the count. A category may therefore add a token its English
 * family already uses; it may never drop one English requires in that category.
 */
function familyPlaceholders(english, base) {
  const tokens = new Set();
  for (const [key, value] of english) {
    if (key !== base && pluralBaseKey(key) !== base) {
      continue;
    }
    for (const token of placeholders(value).split(',').filter(Boolean)) {
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Whether a plural category's placeholder set is English's plus tokens from its
 * own family. Returns false for a non-plural key, for a dropped required token,
 * and for a token no value of the family uses.
 */
function addsFamilyPlaceholderOnly(english, key, actual, expected) {
  const parts = pluralParts(key);
  if (!parts) {
    return false;
  }
  const required = new Set(expected.split(',').filter(Boolean));
  const used = new Set(actual.split(',').filter(Boolean));
  if (used.size <= required.size) {
    return false;
  }
  for (const token of required) {
    if (!used.has(token)) {
      return false;
    }
  }
  const family = familyPlaceholders(english, parts.base);
  for (const token of used) {
    if (!family.has(token)) {
      return false;
    }
  }
  return true;
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
  // English copy that interpolates {{count}} but whose words inflect none or
  // only by count, so English ships a flat key (or a family). A language whose
  // nouns do change with the count may declare a family for that base; see the
  // locale loop below.
  const englishCountedBases = new Set(
    [...english]
      .filter(([key, value]) => /{{\s*count\s*}}/.test(value))
      .map(([key]) => pluralBaseKey(key))
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

  // One key per piece of copy. Two keys holding the same English string cannot
  // be translated apart without the catalogs drifting, so the copy belongs to
  // one key and every call site points at it.
  //
  // Every plural key is exempt, not only the members of one family. So two
  // plural families holding the same copy pass here. That is deliberate: the
  // one-wording rule below groups plural keys too, so the catalogs still cannot
  // drift apart, and only the duplicate key survives. Narrowing the exemption
  // has to compare stems, because a family's bare key carries its `_other` copy
  // by i18next convention and is not a second key for the same string.
  if (catalog.name === 'mobile') {
    const byCopy = new Map();
    for (const [key, value] of english) {
      if (pluralParts(key)) {
        continue;
      }
      if (!byCopy.has(value)) {
        byCopy.set(value, []);
      }
      byCopy.get(value).push(key);
    }
    for (const [value, keys] of byCopy) {
      if (keys.length < 2 || TWO_SENSE_COPY.has(wording(value))) {
        continue;
      }
      fail(
        `${catalog.name}/en: ${keys.length} keys hold the copy "${value}" (${keys.join(', ')}). Point every call site at one key, or add the string to TWO_SENSE_COPY in tools/i18n/check-catalogs.mjs with the two senses it carries.`
      );
    }
  }

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

  checkAgentEditorCopy(english, english, `${catalog.name}/en`);

  const localeValues = new Map();

  for (const tag of present) {
    if (tag === 'en') {
      continue;
    }
    const label = `${catalog.name}/${tag}`;
    const translated = flatten(parseCatalog(join(catalog.dir, `${tag}.json`), label));
    localeValues.set(tag, translated);
    checkAgentEditorCopy(translated, english, label);
    const ownValues = new Set(translated.values());

    // A locale-driven plural family: the English base interpolates {{count}}
    // but has no English family. When the locale declares any member, it must
    // declare every category of its tag; the English `_one`/`_other` siblings
    // of a family English does declare stay mandatory except where the locale
    // carries the flat base key instead.
    const localeFamilies = new Set(
      [...translated.keys()]
        .map(pluralParts)
        .filter(Boolean)
        .map(parts => parts.base)
    );
    for (const key of english.keys()) {
      if (translated.has(key)) {
        continue;
      }
      const parts = pluralParts(key);
      if (
        parts &&
        englishFamilies.has(parts.base) &&
        !localeFamilies.has(parts.base) &&
        translated.has(parts.base)
      ) {
        // The locale kept the flat base key of a counted English family; it
        // owes no categories for that family, so they are deliberately not
        // reported. Only a non-counted English family reports below.
        continue;
      }
      fail(`${label}: missing key "${key}"`);
    }
    for (const key of translated.keys()) {
      if (english.has(key)) {
        continue;
      }
      const parts = pluralParts(key);
      if (parts && (englishFamilies.has(parts.base) || englishCountedBases.has(parts.base))) {
        continue;
      }
      fail(`${label}: extra key "${key}" is not in en.json`);
    }
    const requiredCategories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
    // A locale that declares no member of an English family falls back to its
    // flat base key, so it cannot lack categories it never opted into. A
    // locale-driven family (declared here but not in English) or an English
    // family the locale carries must be complete.
    for (const family of new Set([...englishFamilies, ...localeFamilies])) {
      const localeDeclared = localeFamilies.has(family);
      const englishDriven =
        englishFamilies.has(family) && !englishCountedBases.has(family) && translated.has(family);
      if (!localeDeclared && !englishDriven) {
        continue;
      }
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
      if (!(parts && (englishFamilies.has(parts.base) || englishCountedBases.has(parts.base)))) {
        continue;
      }
      const englishRef =
        english.get(`${parts.base}_${parts.category}`) ??
        english.get(`${parts.base}_other`) ??
        english.get(parts.base);
      const allowed = new Set(
        placeholders(englishRef ?? '')
          .split(',')
          .filter(Boolean)
      );
      for (const ph of placeholders(value).split(',').filter(Boolean)) {
        if (!allowed.has(ph)) {
          fail(`${label}: "${key}" uses placeholder {{${ph}}}, which the English family does not`);
        }
      }
      // Every form keeps the family's visible count unless the reviewed list
      // names it: a form without a numeral reads as an age only when the
      // language spells the number out. A zero form is the exception — "none
      // required" reads better than a numeral beside a noun, and several
      // catalogs already word it that way.
      if (
        parts.category !== 'zero' &&
        !WORDED_COUNTS.has(`${parts.base}:${parts.category}:${tag}`)
      ) {
        for (const ph of familyVisibleCounts(english, parts.base)) {
          if (!placeholders(value).split(',').includes(ph)) {
            fail(
              `${label}: "${key}" drops {{${ph}}} without a reviewed worded form (WORDED_COUNTS)`
            );
          }
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
      if (catalog.name === 'mobile' && key === 'home.noLiveSessions' && value === englishValue) {
        fail(`${label}: "${key}" must be translated`);
      }
      const expected = placeholders(englishValue);
      const actual = placeholders(value);
      const expectedSet = expected.split(',').filter(Boolean);
      const actualSet = actual.split(',').filter(Boolean);
      // Only a reviewed (key, category, locale) entry may say its number as a
      // word; every other form keeps its language's exact placeholder set.
      const parts = pluralParts(key);
      const wordedForm = Boolean(
        parts && WORDED_COUNTS.has(`${parts.base}:${parts.category}:${tag}`)
      );
      const droppedVisibleCount = expectedSet
        .filter(name => !actualSet.includes(name))
        .every(name => name === 'displayCount' || name === 'itemCount');
      const addedPlaceholder = actualSet.some(name => !expectedSet.includes(name));
      if (
        actual !== expected &&
        !addsFamilyPlaceholderOnly(english, key, actual, expected) &&
        !(wordedForm && droppedVisibleCount && !addedPlaceholder)
      ) {
        fail(`${label}: "${key}" placeholders differ from English (${expected || 'none'})`);
      }
      const expectedRefs = nestingRefs(englishValue).join(',');
      if (nestingRefs(value).join(',') !== expectedRefs) {
        fail(`${label}: "${key}" $t() references differ from English (${expectedRefs || 'none'})`);
      }
      const expectedTokens = expansionTokens(englishValue).join(',');
      if (expansionTokens(value).join(',') !== expectedTokens) {
        fail(
          `${label}: "${key}" $TOKEN expansion tokens differ from English (${expectedTokens || 'none'})`
        );
      }
      if (!LOCALE_SEPARATED_KEYS.has(key) && edges(value) !== edges(englishValue)) {
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

    // The separator keys are this catalog's only statement about how it joins
    // one word to the next, and they are allowed to differ from English on
    // purpose — so they have to agree with each other. A padded prefix with a
    // bare connector joins "our" to "Terms" but runs the conjunction into the
    // next noun; the reverse drops the space before the link.
    const prefixValue = translated.get('login.termsPrefix');
    const connectorValue = translated.get('login.termsConnector');
    if (prefixValue !== undefined && connectorValue !== undefined) {
      const paddedPrefix = /\s$/.test(prefixValue);
      const paddedConnector = /^\s/.test(connectorValue) && /\s$/.test(connectorValue);
      if (paddedPrefix !== paddedConnector) {
        fail(
          `${label}: "login.termsPrefix" and "login.termsConnector" disagree about their separator; pad both or neither`
        );
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
        const folded = wording(value, tag);
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
      if (!english.has(key) && !englishFamilies.has(key)) {
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
