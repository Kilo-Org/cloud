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
 * owned. Without the flag it also measures every other catalog: for each family
 * and each language it asks the rule the CI catalog gate enforces,
 * `missingPluralCategories` in tools/lib/catalogs.mjs, and prints one line per
 * language with the number of families that language is missing. That is the
 * report the translation pass works from, so the app's `check:plurals` passes
 * `--source-only`; the locale categories are gated in CI by `check:i18n`
 * (`check-catalogs.mjs`), which asks the same rule. A locale that has not opted
 * into an owed English family is reported by that gate as a missing parity key,
 * not by this worklist. A catalog that cannot be read, parsed, or given plural
 * rules is one problem line naming its language, and the rest of the audit still
 * runs.
 *
 * A counted message whose copy owns no word whose form the count changes — a
 * participle, a bare number in parentheses, a label — needs no family, because
 * there is nothing to inflect. Those are the reviewed `NO_AGREEMENT` entries
 * below, each with the reason it holds.
 *
 * The call sites come from the syntax tree oxc builds (tools/lib/ast.mjs): a
 * call is a call, its arguments are arguments, and an option is a property in
 * key position. Text that only looks like a call — a comment, a string, a type
 * argument — can no longer be counted, and a syntax error is reported instead
 * of leaving the file's messages unaudited.
 *
 * Usage: node tools/i18n/check-plurals.mjs [--source-only]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTranslateCallee, propertyName, unwrap, walk } from '../lib/ast.mjs';
import {
  catalogTags,
  declaresPluralFamily,
  flattenCatalog,
  missingPluralCategories,
} from '../lib/catalogs.mjs';
import { runIfMain } from '../lib/entry-point.mjs';
import { isTestArtifact, parseSourceEntry, parseSourceTree } from '../lib/source-files.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
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
    'agentChat.sessionChanges.reviewTitle',
    'bare count in parentheses: "Review ({{count}})" names no inflected word',
  ],
  [
    'chat.reactions.accessibility',
    'bare count after a label: "{{emoji}} reaction, {{displayCount}}"',
  ],
  [
    'codeReviewer.repos.allModeCount',
    'bare count after a label: "Repositories available: {{displayCount}}" names no inflected word',
  ],
  [
    'securityAgent.orphanedFindings.count',
    'bare count after a label: "Findings: {{count}}" names no inflected word',
  ],
  [
    'securityAgent.orphanedFindings.cleared',
    'bare count after a label: "Findings cleared: {{count}}" names no inflected word',
  ],
  ['prReview.checks.pending', 'participle: "{{displayCount}} pending" has no count form'],
  [
    'prReview.discussion.reactionPill',
    'the noun is already a family: "{{emoji}} reaction, {{displayCount}} {{countLabel}}"',
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
  [
    'modelChat.mcp.notApplied',
    'carried count, no inflected word: "Kilo tools were not added to this chat"',
  ],
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
    'codeReviewer.analytics.trackedReviewsUncounted',
    'counts of a total, not a count of the noun: "{{count}} of the {{total}} finished reviews" reads the same at every count',
  ],
]);

/**
 * The call's key: a string or a template literal without an interpolation is
 * the key itself, and anything else is the expression the key comes from,
 * written the way the source writes it with its whitespace collapsed.
 */
function countedKey(argument, text) {
  if (argument.type === 'Literal' && typeof argument.value === 'string') {
    return { key: argument.value };
  }
  if (argument.type === 'TemplateLiteral' && argument.expressions.length === 0) {
    const [chunk] = argument.quasis;
    return { key: chunk.value.cooked ?? chunk.value.raw };
  }
  return { dynamic: text.slice(argument.start, argument.end).replace(/\s+/g, ' ').trim() };
}

/**
 * One counted call, read from its `CallExpression`, or null when the call is
 * not a counted message: it hands i18next a key and an options object, and one
 * of the object's own keys names a count.
 */
function countedCall(node, text) {
  if (node.type !== 'CallExpression' || !isTranslateCallee(node.callee)) {
    return null;
  }
  if (node.arguments.length < 2) {
    return null;
  }
  const options = unwrap(node.arguments[1]);
  if (options.type !== 'ObjectExpression') {
    return null;
  }
  // Only a property's own key counts: `{ label: count }` names `label`. An
  // empty string key is a name too, so the filter keeps `''`.
  const names = new Set(options.properties.map(propertyName).filter(name => name !== null));
  if (!COUNTED_OPTIONS.some(name => names.has(name))) {
    return null;
  }
  return countedKey(unwrap(node.arguments[0]), text);
}

/**
 * One traversal of the source tree: every counted call, and every file the
 * parser refused. It is the one traversal the accessors below project from, so
 * an audit that asks several questions of the same tree scans it once.
 */
export function auditCountedCalls(rootDir = SOURCE_DIR) {
  const calls = [];
  const problems = [];
  // The app's sources read the way every other diagnostic names them; a
  // fixture tree outside the repository reads from its own root.
  for (const { text, program, problems: unparsed } of parseSourceTree(
    rootDir,
    ROOT,
    isTestArtifact
  )) {
    problems.push(...unparsed);
    walk(program, node => {
      const call = countedCall(node, text);
      if (call !== null) {
        calls.push(call);
      }
    });
  }
  return { calls, problems };
}

/**
 * Every static counted key: `t('key', { … count … })` and its quoted variants.
 * It projects a scan the caller made once with `auditCountedCalls`.
 */
export function collectCountedKeys(scan) {
  return countedKeysFrom(scan.calls);
}

/**
 * Every counted call whose key is a variable expression, as the expression the
 * source writes it, whitespace-normalized. A listed expression in
 * `DYNAMIC_COUNTED_KEYS` names the keys it can produce; an unlisted one is an
 * audit problem, because the audit cannot see which messages a count reaches.
 * It projects a scan the caller made once with `auditCountedCalls`.
 */
export function collectDynamicCountedCalls(scan) {
  return dynamicCallsFrom(scan.calls);
}

/**
 * Every source file the parser refused, as one problem line per error. The
 * tree of such a file is empty, so its counted messages are invisible; saying
 * so keeps a syntax error from passing as a clean audit. It projects a scan the
 * caller made once with `auditCountedCalls`.
 */
export function findUnparsedFiles(scan) {
  return scan.problems;
}

/** The literal-key view of one collection of counted calls. */
function countedKeysFrom(calls) {
  const keys = new Set();
  for (const call of calls) {
    if (call.key !== undefined) {
      keys.add(call.key);
    }
  }
  return [...keys].sort();
}

/** The dynamic-expression view of one collection of counted calls. */
function dynamicCallsFrom(calls) {
  const dynamic = new Set();
  for (const call of calls) {
    if (call.dynamic !== undefined) {
      dynamic.add(call.dynamic);
    }
  }
  return [...dynamic].sort();
}

/**
 * Every key the `McpStatusKey` union in `mcp-settings-state.ts` can name, in the
 * order the union lists them. Two call sites select from that union, so the
 * set is written once. The audit reads the union itself and names a member
 * this list is missing, and a key this list carries that the union no longer
 * names, so the two cannot drift apart. Each key still needs a plural family or
 * its own `NO_AGREEMENT` entry: the list decides which keys the audit looks at,
 * never whether their copy inflects.
 */
const MCP_STATUS_KEYS = [
  'modelChat.mcp.available',
  'modelChat.mcp.connecting',
  'modelChat.mcp.none',
  'modelChat.mcp.notApplied',
  'modelChat.mcp.off',
  'modelChat.mcp.unauthorized',
  'modelChat.mcp.unavailable',
  'modelChat.mcp.unreachable',
];

/**
 * The variable-key counted calls the audit has reviewed, with the keys each
 * expression can produce, the app declaration it mirrors, and where that set is
 * pinned: `source` is the module that owns the declaration, written relative to
 * the repository root, and `declaration` is the type alias or const whose
 * string keys are the set. A key here is checked exactly like a literal one — a
 * plural family, or a `NO_AGREEMENT` entry — and the list itself is checked
 * against its declaration by `checkDynamicCountedKeySources`.
 */
export const DYNAMIC_COUNTED_KEYS = new Map([
  [
    'mcp.view.statusKey',
    {
      keys: MCP_STATUS_KEYS,
      source: 'apps/mobile/src/components/chat/mcp-settings-state.ts',
      declaration: 'McpStatusKey',
      reason: 'every member of the McpStatusKey union',
    },
  ],
  [
    'kilo.statusKey',
    {
      keys: MCP_STATUS_KEYS,
      source: 'apps/mobile/src/components/chat/mcp-settings-state.ts',
      declaration: 'McpStatusKey',
      reason: 'the same McpStatusKey union through kiloServerRow',
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
      source: 'apps/mobile/src/components/chat/mcp-settings-state.ts',
      declaration: 'RemoteMcpStatusKey',
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
        'profiles.counts.setupCommands',
        'profiles.counts.agents',
      ],
      source: 'apps/mobile/src/lib/profile-count-labels.ts',
      declaration: 'COUNT_KEYS',
      reason: 'COUNT_KEYS map in profile-count-labels.ts; every unit word but MCP inflects',
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
      source: 'apps/mobile/src/components/pr-review/pr-review-checks-status-row.tsx',
      declaration: 'STATUS_LABEL_KEY',
      reason:
        'STATUS_LABEL_KEY map in pr-review-checks-status-row.tsx; passed, failed and skipped use plural families; pending remains invariant',
    },
  ],
  [
    'BUCKET_KEYS[bucket]',
    {
      keys: [
        'securityAgent.dashboard.repoSummaryOpen',
        'securityAgent.dashboard.repoSummaryCritical',
        'securityAgent.dashboard.repoSummaryHigh',
        'securityAgent.dashboardMetrics.breakdownCritical',
        'securityAgent.dashboardMetrics.breakdownHigh',
        'securityAgent.dashboardMetrics.breakdownMediumLow',
      ],
      source: 'apps/mobile/src/components/security-agent/severity-count-phrase.ts',
      declaration: 'BUCKET_KEYS',
      reason:
        'BUCKET_KEYS map in severity-count-phrase.ts; each bucket of a dashboard line agrees with its own count',
    },
  ],
]);

/**
 * The string keys one type node names, in the order it writes them. Each member
 * of a union is a literal type holding the string, and the walk reads through
 * any wrapper the parser keeps around a member, so a parenthesised member names
 * its key like a bare one.
 */
function typeKeys(typeNode) {
  const keys = [];
  walk(typeNode, node => {
    if (node.type !== 'TSLiteralType') {
      return;
    }
    const literal = unwrap(node.literal);
    if (literal.type === 'Literal' && typeof literal.value === 'string') {
      keys.push(literal.value);
    }
  });
  return keys;
}

/**
 * The string keys one const object declaration's initialiser names, in the
 * order it writes them, or null when the initialiser is not an object. A
 * property whose value is not a string literal names no key — a spread or a
 * computed value, which these declarations do not use.
 */
function objectKeys(initializer) {
  const object = unwrap(initializer);
  if (object.type !== 'ObjectExpression') {
    return null;
  }
  const keys = [];
  for (const property of object.properties) {
    if (property.type !== 'Property') {
      continue;
    }
    const value = unwrap(property.value);
    if (value.type === 'Literal' && typeof value.value === 'string') {
      keys.push(value.value);
    }
  }
  return keys;
}

/**
 * The keys one declaration names, read from the syntax tree of the module that
 * owns it: a union alias's members, or a const object's values, in the order
 * the declaration writes them. Null when the module declares no such alias or
 * const, so a renamed declaration is reported instead of passing as an empty
 * set.
 */
function declaredKeys(entry, declaration) {
  let keys = null;
  walk(entry.program, node => {
    if (keys !== null) {
      return;
    }
    if (node.type === 'TSTypeAliasDeclaration' && node.id.name === declaration) {
      keys = typeKeys(node.typeAnnotation);
      return;
    }
    if (
      node.type !== 'VariableDeclarator' ||
      node.id.type !== 'Identifier' ||
      node.id.name !== declaration
    ) {
      return;
    }
    // A declarator without an initialiser does not declare the keys either,
    // and objectKeys would read through null, so it stays the same null the
    // missing-alias case reports.
    if (node.init !== null) {
      keys = objectKeys(node.init);
    }
  });
  return keys;
}

/**
 * One declaration module, read and parsed once: the normalised path its
 * diagnostics name it by, the syntax tree its declarations are read from, the
 * lines that say the parser refused it, and the keys read from each declaration
 * so far — the two `McpStatusKey` entries share one read.
 */
function readDeclarationModule(rootDir, source) {
  const file = join(rootDir, source);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      path: source,
      entry: null,
      declarations: new Map(),
      problems: [`${source}: cannot read the module that declares its keys: ${message}`],
    };
  }
  const entry = parseSourceEntry(rootDir, rootDir, file, text);
  return { path: entry.path, entry, declarations: new Map(), problems: entry.problems };
}

/**
 * Every mismatch between a reviewed `DYNAMIC_COUNTED_KEYS` entry and the app
 * declaration it mirrors. A key the declaration names and the entry does not
 * list is a message the audit never reads; a key the entry lists and the
 * declaration dropped is a stale review. Each mismatch is one problem line
 * naming the key, the expression, the declaration and the module that owns it.
 * Empty on a healthy tree. It reads the declaration modules only, so it is
 * separate from the source-tree scan.
 */
export function checkDynamicCountedKeySources(rootDir = ROOT) {
  const problems = [];
  const modules = new Map();
  for (const [expression, listed] of DYNAMIC_COUNTED_KEYS) {
    let source = modules.get(listed.source);
    if (source === undefined) {
      source = readDeclarationModule(rootDir, listed.source);
      modules.set(listed.source, source);
      for (const problem of source.problems) {
        problems.push(problem);
      }
    }
    // A file the parser refused has no declaration to read, and its parse
    // problems already say so; naming every listed key as undeclared would
    // only bury that line.
    if (source.entry === null || source.problems.length > 0) {
      continue;
    }
    if (!source.declarations.has(listed.declaration)) {
      source.declarations.set(listed.declaration, declaredKeys(source.entry, listed.declaration));
    }
    const keys = source.declarations.get(listed.declaration);
    if (keys === null) {
      problems.push(
        `${source.path}: ${listed.declaration} is not declared in this module, so ${expression} cannot be checked against it`
      );
      continue;
    }
    const listedKeys = new Set(listed.keys);
    for (const key of new Set(keys)) {
      if (!listedKeys.has(key)) {
        problems.push(
          `${source.path}: ${listed.declaration} declares "${key}", which ${expression} does not list; the call at its site can produce an unaudited message`
        );
      }
    }
    const declared = new Set(keys);
    for (const key of listed.keys) {
      if (!declared.has(key)) {
        problems.push(
          `${source.path}: ${expression} lists "${key}", which ${listed.declaration} does not declare`
        );
      }
    }
  }
  return problems;
}

/** The English catalog, flattened. */
export function readEnglishCatalog(localesDir = LOCALES_DIR) {
  return flattenCatalog(JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8')));
}

/**
 * Every counted key the audit is responsible for: the literal ones and every
 * key a reviewed dynamic call can produce.
 */
function auditKeys(calls) {
  const keys = new Set(countedKeysFrom(calls));
  for (const expression of dynamicCallsFrom(calls)) {
    const listed = DYNAMIC_COUNTED_KEYS.get(expression);
    if (listed !== undefined) {
      for (const key of listed.keys) {
        keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

/** The unlisted dynamic calls among one collection of counted calls. */
function unlistedDynamicCalls(calls) {
  return dynamicCallsFrom(calls).filter(expression => !DYNAMIC_COUNTED_KEYS.has(expression));
}

/** The countless counted keys among one collection, checked against `english`. */
function countlessFamilies(calls, english) {
  return auditKeys(calls).filter(
    key => !NO_AGREEMENT.has(key) && !declaresPluralFamily(english, key)
  );
}

/**
 * The variable-key counted calls that are not in `DYNAMIC_COUNTED_KEYS`. Each
 * one is a call whose possible messages the audit cannot see. It projects a
 * scan the caller made once with `auditCountedCalls`.
 */
export function findUnlistedDynamicCalls(scan) {
  return unlistedDynamicCalls(scan.calls);
}

/**
 * The counted keys — literal, or produced by a reviewed dynamic call — that
 * are neither a plural family in English nor a reviewed `NO_AGREEMENT` entry.
 * Empty on a healthy tree; every entry is a message whose count cannot select
 * a form. It projects a scan the caller made once with `auditCountedCalls`,
 * and reads the English catalog per call.
 */
export function findCountlessFamilies(scan, localesDir = LOCALES_DIR) {
  return countlessFamilies(scan.calls, readEnglishCatalog(localesDir));
}

function run() {
  const sourceOnly = process.argv.includes('--source-only');
  const problems = [];
  const report = [];
  const { calls, problems: unparsed } = auditCountedCalls(SOURCE_DIR);
  const english = readEnglishCatalog();

  for (const problem of unparsed) {
    problems.push(problem);
  }

  for (const problem of checkDynamicCountedKeySources()) {
    problems.push(problem);
  }

  for (const key of countlessFamilies(calls, english)) {
    problems.push(
      `en: counted key "${key}" has no plural family; add _one/_other or list it in NO_AGREEMENT`
    );
  }

  for (const expression of unlistedDynamicCalls(calls)) {
    problems.push(
      `en: counted call with variable key "${expression}" is not listed in DYNAMIC_COUNTED_KEYS; name its possible keys or add the call site's expression`
    );
  }

  if (!sourceOnly) {
    let totalKeys = 0;
    for (const tag of catalogTags(LOCALES_DIR)) {
      if (tag === 'en') {
        continue;
      }
      let catalog;
      let missing;
      try {
        catalog = flattenCatalog(
          JSON.parse(readFileSync(join(LOCALES_DIR, `${tag}.json`), 'utf8'))
        );
        missing = missingPluralCategories(english, catalog, tag);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`${tag}: cannot audit catalog: ${message}`);
        continue;
      }
      if (missing.size > 0) {
        report.push(`${tag}: ${missing.size} keys`);
        totalKeys += missing.size;
      }
    }
    if (report.length > 0) {
      console.log(report.join('\n'));
      console.log(` TOTAL ${report.length} languages, ${totalKeys} keys`);
    }
  }

  for (const problem of problems) {
    console.error(problem);
  }

  if (problems.length > 0 || report.length > 0) {
    const counts = [];
    if (problems.length > 0) {
      counts.push(`${problems.length} problem(s)`);
    }
    if (report.length > 0) {
      counts.push(`${report.length} language(s) with missing plural categories`);
    }
    console.error(`\ncheck-plurals: ${counts.join('; ')}`);
    process.exit(1);
  }

  console.log(
    sourceOnly
      ? 'check-plurals: every counted message declares a plural family or is reviewed in NO_AGREEMENT'
      : 'check-plurals: every counted message declares a plural family or is reviewed in NO_AGREEMENT, and every required plural family declares its locale categories'
  );
}

runIfMain(run, import.meta.url);
