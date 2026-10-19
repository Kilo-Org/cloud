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
 * English declares its plural family. A call site whose key is a variable —
 * `t(mcp.view.statusKey, { count })` — is checked through the reviewed
 * `DYNAMIC_COUNTED_KEYS` list, which names the keys each expression can
 * produce; an unlisted variable-key call is a problem of its own. With
 * `--source-only` it stops after English, which is the check the mobile app
 * owns. Without the flag it also measures every other catalog: for each family
 * and each language it looks for the categories that language's own plural
 * rules require, and prints one line per language with the number of families
 * the language is missing. That is the report the translation pass works from.
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
  [
    'modelChat.mcp.available',
    'carried count, no inflected word: "Tools available: {{count}}" counts by number alone',
  ],
  ['modelChat.mcp.connecting', 'carried count, no inflected word: "Connecting to Kilo tools…"'],
  ['modelChat.mcp.none', 'carried count, no inflected word: "No tools available"'],
  ['modelChat.mcp.off', 'carried count, no inflected word: "Kilo tools are off"'],
  [
    'modelChat.mcp.unauthorized',
    'carried count, no inflected word: "Kilo tools refused this session"',
  ],
  ['modelChat.mcp.unavailable', 'carried count, no inflected word: "Kilo tools are not available"'],
  ['modelChat.mcp.unreachable', 'carried count, no inflected word: "Couldn\'t reach Kilo tools"'],
  ['modelChat.mcp.serverChecking', 'carried count, no inflected word: "Checking this server…"'],
  ['modelChat.mcp.serverOff', 'carried count, no inflected word: "This server is off"'],
  [
    'modelChat.mcp.serverUnreachable',
    'carried count, no inflected word: "Couldn\'t reach this server"',
  ],
  [
    'modelChat.mcpOAuth.serverNeedsSignIn',
    'carried count, no inflected word: "Sign in to use this server"',
  ],
  ['profiles.counts.mcp', 'initialism, not agreement: "{{count}} MCP" names no inflected word'],
  [
    'profiles.counts.varsShort',
    'compact suffix, not agreement: "{{count}}v" names no inflected word',
  ],
  [
    'profiles.counts.skillsShort',
    'compact suffix, not agreement: "{{count}}s" names no inflected word',
  ],
  [
    'profiles.counts.commandsShort',
    'compact suffix, not agreement: "{{count}}c" names no inflected word',
  ],
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

/** A quoted literal key argument: `'k'`, `"k"` or a backtick run without `${`. */
function literalKeyArgument(text, start) {
  const quote = text[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') {
    return null;
  }
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      return null;
    }
    if (ch === quote) {
      return text.slice(start + 1, i).replace(/\\(['"`\\])/g, '$1');
    }
    i++;
  }
  return null;
}

/** One counted call: its literal key, or the expression the key comes from. */
function countedCall(text, keyStart) {
  const openIndex = text.indexOf('(', keyStart);
  if (openIndex === -1) {
    return null;
  }
  const closeIndex = findCallClose(text, openIndex);
  if (closeIndex === -1) {
    return null;
  }
  const argsText = text.slice(openIndex + 1, closeIndex);
  const comma = findTopLevelComma(argsText);
  if (comma === -1) {
    return null;
  }
  const options = argsText.slice(comma + 1).trim();
  if (
    !options.startsWith('{') ||
    !COUNTED_OPTIONS.some(name => optionsPropertyNames(options).has(name))
  ) {
    return null;
  }
  const first = argsText.slice(0, comma).replace(/\s+/g, ' ').trim();
  const firstArgStart = argsText.length - argsText.trimStart().length;
  const literal = literalKeyArgument(argsText, firstArgStart);
  return literal === null ? { dynamic: first } : { key: literal };
}

/** Every static counted key: `t('key', { … count … })` and its quoted variants. */
export function collectCountedKeys(rootDir = SOURCE_DIR) {
  const keys = new Set();
  for (const call of collectCountedCalls(rootDir)) {
    if (call.key !== undefined) {
      keys.add(call.key);
    }
  }
  return [...keys].sort();
}

/**
 * Every counted call whose key is a variable expression, as the expression the
 * source writes it, whitespace-normalized. A listed expression in
 * `DYNAMIC_COUNTED_KEYS` names the keys it can produce; an unlisted one is an
 * audit problem, because the audit cannot see which messages a count reaches.
 */
export function collectDynamicCountedCalls(rootDir = SOURCE_DIR) {
  const dynamic = new Set();
  for (const call of collectCountedCalls(rootDir)) {
    if (call.dynamic !== undefined) {
      dynamic.add(call.dynamic);
    }
  }
  return [...dynamic].sort();
}

function collectCountedCalls(rootDir) {
  const calls = [];
  const callPattern = /(?<![\w.$])(?:i18n\.)?t\s*\(/g;
  for (const file of sourceFiles(rootDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(callPattern)) {
      const call = countedCall(text, match.index);
      if (call !== null) {
        calls.push(call);
      }
    }
  }
  return calls;
}

/**
 * The variable-key counted calls the audit has reviewed, with the keys each
 * expression can produce and where that set is pinned. A key here is checked
 * exactly like a literal one: a plural family, or a `NO_AGREEMENT` entry.
 */
export const DYNAMIC_COUNTED_KEYS = new Map([
  [
    'mcp.view.statusKey',
    {
      keys: [
        'modelChat.mcp.available',
        'modelChat.mcp.connecting',
        'modelChat.mcp.none',
        'modelChat.mcp.off',
        'modelChat.mcp.unauthorized',
        'modelChat.mcp.unavailable',
        'modelChat.mcp.unreachable',
      ],
      reason: 'McpStatusKey union in mcp-settings-state.ts; only the count-free statuses',
    },
  ],
  [
    'kilo.statusKey',
    {
      keys: [
        'modelChat.mcp.available',
        'modelChat.mcp.connecting',
        'modelChat.mcp.none',
        'modelChat.mcp.off',
        'modelChat.mcp.unauthorized',
        'modelChat.mcp.unavailable',
        'modelChat.mcp.unreachable',
      ],
      reason: 'same McpStatusKey union through kiloServerRow in mcp-settings-state.ts',
    },
  ],
  [
    'row.statusKey',
    {
      keys: [
        'modelChat.mcp.none',
        'modelChat.mcp.serverChecking',
        'modelChat.mcp.serverOff',
        'modelChat.mcp.serverToolCount',
        'modelChat.mcp.serverUnreachable',
        'modelChat.mcpOAuth.serverNeedsSignIn',
      ],
      reason: 'RemoteMcpStatusKey union in mcp-settings-state.ts; serverToolCount inflects',
    },
  ],
  [
    'COUNT_KEYS[item.kind]',
    {
      keys: [
        'profiles.counts.vars',
        'profiles.counts.mcp',
        'profiles.counts.skills',
        'profiles.counts.commands',
      ],
      reason: 'COUNT_KEYS map in profile-count-labels.ts; vars, skills and commands inflect',
    },
  ],
  [
    'STATUS_LABEL_KEY[status]',
    {
      keys: [
        'prReview.checks.passed',
        'prReview.checks.failed',
        'prReview.checks.pending',
        'prReview.checks.skipped',
      ],
      reason:
        'STATUS_LABEL_KEY map in pr-review-checks-status-row.tsx; participles, no inflected word',
    },
  ],
  [
    'SHORT_COUNT_KEYS.get(item.kind) ?? COUNT_KEYS[item.kind]',
    {
      keys: [
        'profiles.counts.varsShort',
        'profiles.counts.skillsShort',
        'profiles.counts.commandsShort',
        'profiles.counts.vars',
        'profiles.counts.mcp',
        'profiles.counts.skills',
        'profiles.counts.commands',
      ],
      reason: 'SHORT_COUNT_KEYS fallback in profile-count-labels.ts; all four unit words',
    },
  ],
]);

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
 * Every counted key the audit is responsible for: the literal ones and every
 * key a reviewed dynamic call can produce.
 */
function auditKeys(rootDir) {
  const keys = new Set(collectCountedKeys(rootDir));
  for (const expression of collectDynamicCountedCalls(rootDir)) {
    const listed = DYNAMIC_COUNTED_KEYS.get(expression);
    if (listed !== undefined) {
      for (const key of listed.keys) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/**
 * The variable-key counted calls that are not in `DYNAMIC_COUNTED_KEYS`. Each
 * one is a call whose possible messages the audit cannot see.
 */
export function findUnlistedDynamicCalls(rootDir = SOURCE_DIR) {
  return collectDynamicCountedCalls(rootDir).filter(
    expression => !DYNAMIC_COUNTED_KEYS.has(expression)
  );
}

/**
 * The counted keys — literal, or produced by a reviewed dynamic call — that
 * are neither a plural family in English nor a reviewed `NO_AGREEMENT` entry.
 * Empty on a healthy tree; every entry is a message whose count cannot select
 * a form.
 */
export function findCountlessFamilies(rootDir = SOURCE_DIR, localesDir = LOCALES_DIR) {
  const english = readEnglishCatalog(localesDir);
  return auditKeys(rootDir).filter(key => !NO_AGREEMENT.has(key) && !hasFamily(english, key));
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

  for (const expression of collectDynamicCountedCalls()) {
    if (!DYNAMIC_COUNTED_KEYS.has(expression)) {
      problems.push(
        `en: counted call with variable key "${expression}" is not listed in DYNAMIC_COUNTED_KEYS; name its possible keys or add the call site's expression`
      );
      continue;
    }
    for (const key of DYNAMIC_COUNTED_KEYS.get(expression).keys) {
      if (NO_AGREEMENT.has(key)) {
        continue;
      }
      if (!hasFamily(english, key)) {
        problems.push(
          `en: counted key "${key}" (from variable key "${expression}") has no plural family; add _one/_other or list it in NO_AGREEMENT`
        );
      }
    }
  }

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
