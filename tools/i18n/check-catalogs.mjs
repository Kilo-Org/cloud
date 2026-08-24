#!/usr/bin/env node
/**
 * Catalog parity check.
 *
 * Every translated catalog must be a key-for-key copy of the English one, and
 * every key the source uses must exist. This runs in CI, so a locale can never
 * drift from English without the build saying so.
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
  { name: 'notifications', dir: join(ROOT, 'packages/notifications/src/locales'), checkUsage: false },
];

const problems = [];
const fail = (message) => problems.push(message);

/** The supported tags, read from the one source of truth. */
function supportedLanguages() {
  const source = readFileSync(LANGUAGES_FILE, 'utf8');
  const block = /export const SUPPORTED_LANGUAGES = \[([^\]]*)\]/.exec(source);
  if (!block) {
    throw new Error('SUPPORTED_LANGUAGES not found in languages.ts');
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
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
  return [...value.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1]).sort().join(',');
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

const tags = supportedLanguages();

for (const catalog of CATALOGS) {
  const present = readdirSync(catalog.dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));

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
  for (const [key, value] of english) {
    if (value.trim() === '') {
      fail(`${catalog.name}/en: "${key}" is empty`);
    }
  }

  for (const tag of present) {
    if (tag === 'en') {
      continue;
    }
    const label = `${catalog.name}/${tag}`;
    const translated = flatten(parseCatalog(join(catalog.dir, `${tag}.json`), label));

    for (const key of english.keys()) {
      if (!translated.has(key)) {
        fail(`${label}: missing key "${key}"`);
      }
    }
    for (const key of translated.keys()) {
      if (!english.has(key)) {
        fail(`${label}: extra key "${key}" is not in en.json`);
      }
    }
    for (const [key, value] of translated) {
      if (!english.has(key)) {
        continue;
      }
      if (value.trim() === '') {
        fail(`${label}: "${key}" is empty`);
      }
      const expected = placeholders(english.get(key));
      if (placeholders(value) !== expected) {
        fail(`${label}: "${key}" placeholders differ from English (${expected || 'none'})`);
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
      if (!referenced.has(key)) {
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
