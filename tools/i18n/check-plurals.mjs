#!/usr/bin/env node
/**
 * Plural-family audit.
 *
 * A message whose call site hands i18next a `count` is a counted message: the
 * library selects one of the message's plural categories from that number
 * (`_one`, `_few`, `_many`, `_other`). When the message is a single invariant
 * string instead of a family, every count renders the same form — Serbian
 * showed "1 stavki" and "2 stavki" for exactly that reason.
 *
 * This script finds every counted message in the mobile source and checks that
 * English declares its plural family. With `--source-only` it stops after
 * English, which is the check the mobile app owns. Without the flag it also
 * measures every other catalog: for each family and each language it looks for
 * the categories that language's own plural rules require, and prints one line
 * per language with the number of families the language is missing. That is
 * the report the translation pass works from.
 *
 * A counted message whose copy owns no word whose form the count changes — a
 * participle, a bare number in parentheses, a label — needs no family, because
 * there is nothing to inflect. Those are the reviewed `NO_AGREEMENT` entries
 * below, each with the reason it holds.
 *
 * Usage: node tools/i18n/check-plurals.mjs [--source-only]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../../', import.meta.url).pathname;
const SOURCE_DIR = join(ROOT, 'apps/mobile/src');
const LOCALES_DIR = join(ROOT, 'apps/mobile/src/i18n/locales');

/**
 * The option keys that make a call site a counted one. `count` is i18next's
 * own; `displayCount` and `itemCount` are how the app passes the formatted
 * number it renders beside the copy, so a message that uses either one is a
 * counted message even before `count` itself is wired through.
 */
const COUNTED_OPTIONS = ['count', 'displayCount', 'itemCount'];

/**
 * Counted messages whose English copy has no word whose form the count
 * changes, so a plural family would be noise. Reviewed one by one: before
 * adding an entry, read the English copy and confirm every word reads the same
 * at 1 and at 5. If a word does change, declare the family instead.
 */
export const NO_AGREEMENT = new Map([
  [
    'agentChat.blockingCard.positionHint',
    'position, not agreement: "(1 of {{displayCount}})" names no inflected word',
  ],
  [
    'agentChat.contextUsage.modelAccessibilityLabel',
    'accessibility label: "{{name}}, {{provider}}, {{steps}}, {{cost}}" holds no counted noun',
  ],
  [
    'agentChat.preparation.setupCommandOf',
    'ordinal position: "Setup command {{index}} of {{displayCount}}" names no inflected word',
  ],
  [
    'chat.reactions.accessibility',
    'bare count after a label: "{{emoji}} reaction, {{displayCount}}"',
  ],
  ['codeReviewer.overview.nSelected', 'participle: "{{displayCount}} selected" has no count form'],
  ['prReview.checks.passed', 'participle: "{{displayCount}} passed" has no count form'],
  ['prReview.checks.failed', 'participle: "{{displayCount}} failed" has no count form'],
  ['prReview.checks.pending', 'participle: "{{displayCount}} pending" has no count form'],
  ['prReview.checks.skipped', 'participle: "{{displayCount}} skipped" has no count form'],
  [
    'prReview.discussion.reactionPill',
    'the noun is already a family: "{{emoji}} reaction, {{displayCount}} {{countLabel}}"',
  ],
  [
    'securityAgent.analysis.whereFound',
    'bare count in parentheses: "Where this was found ({{displayCount}})"',
  ],
  [
    'securityAgent.remediation.attemptHistory',
    'bare count in parentheses: "Attempt history ({{displayCount}})"',
  ],
  [
    'securityAgent.settingsOverview.automationCount',
    'fixed total: "{{displayCount}} of 3 enabled" reads the same at every count',
  ],
  [
    'securityAgent.settingsOverview.notificationsCount',
    'fixed total: "{{displayCount}} of 2 enabled" reads the same at every count',
  ],
  [
    'prReview.fileList.filesViewed',
    'counts of a total, not a count of the noun: "Files · {{viewed}} of {{total}} viewed"',
  ],
  [
    'prReview.fileNavigator.viewedCount',
    'counts of a total, not a count of the noun: "{{viewed}} of {{total}} viewed"',
  ],
  [
    'prReview.fileNavigator.viewedOfListed',
    'counts of a total, not a count of the noun: "{{viewed}} of {{total}} viewed of listed files"',
  ],
  [
    'prReview.fileNavigator.loadingFiles',
    'progress read-out: "Loading {{loaded}} of {{total}}…" has no inflected word',
  ],
  ['prReview.hunkRows.loadingAllFiles', 'progress read-out: "Loading all files — {{loaded}}…"'],
  [
    'prReview.hunkRows.loadingAllFilesOf',
    'progress read-out: "Loading all files — {{loaded}} of {{total}}…"',
  ],
  [
    'prReview.hunkRows.loadingLines',
    'progress read-out: "Loading {{loaded}} of {{total}} lines…" — "lines" counts loaded, and the row is a spinner',
  ],
  ['prReview.hunkRows.loadingContext', 'progress read-out: "Loading context…" has no count'],
]);

/** The source files the audit scans: app code, not tests or mounted harnesses. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        sourceFiles(path, out);
      }
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.mounted.')
    ) {
      out.push(path);
    }
  }
  return out;
}

/** Skip a quoted run, returning the index of its closing quote. */
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      return i;
    }
    i++;
  }
  return text.length - 1;
}

/** Whether the character opens/closes a bracket that changes nesting depth. */
const OPENERS = '([{';
const CLOSERS = ')]}';

/**
 * The index of the bracket that closes the call opened at `openIndex`, matching
 * the call's own parentheses so a nested call's parens do not end the scan.
 */
function findCallClose(text, openIndex) {
  const stack = [];
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) {
        return -1;
      }
      i = newline;
      continue;
    }
    if (OPENERS.includes(ch)) {
      stack.push(ch);
    } else if (CLOSERS.includes(ch)) {
      stack.pop();
      if (stack.length === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** The index of the first comma that is not inside a string or bracket. */
function findTopLevelComma(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (OPENERS.includes(ch)) {
      stack.push(ch);
    } else if (CLOSERS.includes(ch)) {
      stack.pop();
    } else if (ch === ',' && stack.length === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The property names written directly on the options object `{ … }`. A nested
 * call's argument named `count` is not a property of the options, so the depth
 * filter keeps the scan honest.
 */
function optionsPropertyNames(objectText) {
  const names = new Set();
  if (!objectText.startsWith('{')) {
    return names;
  }
  let depth = 0;
  let i = 0;
  while (i < objectText.length) {
    const ch = objectText[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(objectText, i) + 1;
      continue;
    }
    if (OPENERS.includes(ch)) {
      depth++;
      i++;
      continue;
    }
    if (CLOSERS.includes(ch)) {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      let end = i;
      while (end < objectText.length && /[\w$]/.test(objectText[end])) {
        end++;
      }
      const name = objectText.slice(i, end);
      let next = end;
      while (next < objectText.length && /\s/.test(objectText[next])) {
        next++;
      }
      if (objectText[next] === ':' || objectText[next] === ',' || objectText[next] === '}') {
        names.add(name);
      }
      i = end;
      continue;
    }
    i++;
  }
  return names;
}

/** The options object text of a `t('key', { … })` call, or null. */
function optionsObjectText(text, openIndex) {
  const closeIndex = findCallClose(text, openIndex);
  if (closeIndex === -1) {
    return null;
  }
  const argsText = text.slice(openIndex + 1, closeIndex);
  const comma = findTopLevelComma(argsText);
  if (comma === -1) {
    return null;
  }
  const rest = argsText.slice(comma + 1).trim();
  return rest.startsWith('{') ? rest : null;
}

/**
 * Every key the source hands a count to: `t('key', { … })` and
 * `i18n.t('key', { … })` whose options carry `count`, `displayCount` or
 * `itemCount`. Sorted so the check's output is stable.
 */
export function collectCountedKeys(rootDir = SOURCE_DIR) {
  const counted = new Set();
  const callPattern = /(?<![\w.$])(?:i18n\.)?t\(\s*'([^'\\\n]*)'/g;
  for (const file of sourceFiles(rootDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(callPattern)) {
      const options = optionsObjectText(text, match.index + match[0].indexOf('('));
      if (options === null) {
        continue;
      }
      const names = optionsPropertyNames(options);
      if (COUNTED_OPTIONS.some(name => names.has(name))) {
        counted.add(match[1]);
      }
    }
  }
  return [...counted].sort();
}

/** Flatten a catalog to dotted keys, the same shape check-catalogs.mjs uses. */
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

/** The English catalog, flattened. */
export function readEnglishCatalog(localesDir = LOCALES_DIR) {
  return flatten(JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8')));
}

const PLURAL_SUFFIX_RE = /_(?:zero|one|two|few|many|other)$/;

/** The base key of a plural family, or null when the key is not a category. */
export function pluralFamilyBase(key) {
  return PLURAL_SUFFIX_RE.test(key) ? key.replace(PLURAL_SUFFIX_RE, '') : null;
}

/** Every plural family English declares, as its base key. */
export function englishPluralFamilies(english = readEnglishCatalog()) {
  return [...new Set([...english.keys()].map(pluralFamilyBase).filter(Boolean))].sort();
}

/**
 * Whether English declares a plural family for `key`. English needs the `_one`
 * and `_other` categories, so a family is complete only when both are present.
 */
function hasFamily(english, key) {
  return english.has(`${key}_one`) && english.has(`${key}_other`);
}

/**
 * The counted keys that are neither a plural family in English nor a reviewed
 * `NO_AGREEMENT` entry. Empty on a healthy tree; every entry is a message whose
 * count cannot select a form.
 */
export function findCountlessFamilies(rootDir = SOURCE_DIR, localesDir = LOCALES_DIR) {
  const english = readEnglishCatalog(localesDir);
  return collectCountedKeys(rootDir).filter(
    key => !NO_AGREEMENT.has(key) && !hasFamily(english, key)
  );
}

/** The locale tags present on disk, without the `.json` extension. */
function localeTags(localesDir = LOCALES_DIR) {
  return readdirSync(localesDir)
    .filter(name => name.endsWith('.json'))
    .map(name => name.replace(/\.json$/, ''))
    .sort();
}

function run() {
  const sourceOnly = process.argv.includes('--source-only');
  const problems = [];
  const english = readEnglishCatalog();

  for (const key of collectCountedKeys()) {
    if (NO_AGREEMENT.has(key)) {
      continue;
    }
    if (!hasFamily(english, key)) {
      problems.push(
        `en: counted key "${key}" has no plural family; add _one/_other or list it in NO_AGREEMENT`
      );
    }
  }

  if (!sourceOnly) {
    const families = englishPluralFamilies(english);
    const report = [];
    let totalKeys = 0;
    for (const tag of localeTags()) {
      if (tag === 'en') {
        continue;
      }
      const catalog = flatten(JSON.parse(readFileSync(join(LOCALES_DIR, `${tag}.json`), 'utf8')));
      const categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
      let flagged = 0;
      for (const family of families) {
        if (categories.some(category => !catalog.has(`${family}_${category}`))) {
          flagged++;
        }
      }
      if (flagged > 0) {
        report.push(`${tag}: ${flagged} keys`);
        totalKeys += flagged;
        problems.push(`${tag}: ${flagged} plural family key(s) lack a category of ${tag}`);
      }
    }
    if (report.length > 0) {
      console.log(report.join('\n'));
      console.log(` TOTAL ${report.length} languages, ${totalKeys} keys`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(problem);
    }
    console.error(`\ncheck-plurals: ${problems.length} problem(s)`);
    process.exit(1);
  }

  console.log(
    sourceOnly
      ? 'check-plurals: en declares a plural family for every counted message'
      : 'check-plurals: every counted message and every locale declares its plural categories'
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run();
}
