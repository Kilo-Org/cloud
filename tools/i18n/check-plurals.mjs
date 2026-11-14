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
 * the language is missing. That is the report the translation pass works from,
 * so the app's `check:plurals` passes `--source-only`; the locale categories
 * are gated in CI by `check:i18n` (`check-catalogs.mjs`). A catalog that cannot
 * be read, parsed, or given plural rules is one problem line naming its
 * language, and the rest of the audit still runs.
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isTranslateCallee, propertyName, unwrap, walk } from '../lib/ast.mjs';
import {
  declaresPluralFamily,
  familiesOwedByEveryLocale,
  flattenCatalog,
  pluralFamilyBases,
  pluralParts,
} from '../lib/catalogs.mjs';
import { isTestArtifact, parseSourceTree } from '../lib/source-files.mjs';

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
    'securityAgent.auditReport.severityCount',
    'bare count before a severity adjective: "{{displayCount}} Critical" has no inflected word',
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

/** One traversal of the source tree: every counted call, and every file the parser refused. */
function auditTree(rootDir) {
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

/** Every static counted key: `t('key', { … count … })` and its quoted variants. */
export function collectCountedKeys(rootDir = SOURCE_DIR) {
  return countedKeysFrom(auditTree(rootDir).calls);
}

/**
 * Every counted call whose key is a variable expression, as the expression the
 * source writes it, whitespace-normalized. A listed expression in
 * `DYNAMIC_COUNTED_KEYS` names the keys it can produce; an unlisted one is an
 * audit problem, because the audit cannot see which messages a count reaches.
 */
export function collectDynamicCountedCalls(rootDir = SOURCE_DIR) {
  return dynamicCallsFrom(auditTree(rootDir).calls);
}

/**
 * Every source file the parser refused, as one problem line per error. The
 * tree of such a file is empty, so its counted messages are invisible; saying
 * so keeps a syntax error from passing as a clean audit.
 */
export function findUnparsedFiles(rootDir = SOURCE_DIR) {
  return auditTree(rootDir).problems;
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
 * set is written once: a member added to the union is audited by adding it
 * here, and the audit then expects a plural family or its own `NO_AGREEMENT`
 * entry for it. The list decides which keys the audit looks at, never whether
 * their copy inflects.
 */
const MCP_STATUS_KEYS = [
  'modelChat.mcp.available',
  'modelChat.mcp.connecting',
  'modelChat.mcp.none',
  'modelChat.mcp.off',
  'modelChat.mcp.unauthorized',
  'modelChat.mcp.unavailable',
  'modelChat.mcp.unreachable',
];

/**
 * The variable-key counted calls the audit has reviewed, with the keys each
 * expression can produce and where that set is pinned. A key here is checked
 * exactly like a literal one: a plural family, or a `NO_AGREEMENT` entry.
 */
export const DYNAMIC_COUNTED_KEYS = new Map([
  [
    'mcp.view.statusKey',
    {
      keys: MCP_STATUS_KEYS,
      reason: 'McpStatusKey union in mcp-settings-state.ts; only the count-free statuses',
    },
  ],
  [
    'kilo.statusKey',
    {
      keys: MCP_STATUS_KEYS,
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
        'profiles.counts.setupCommands',
        'profiles.counts.agents',
      ],
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
      reason:
        'BUCKET_KEYS map in severity-count-phrase.ts; each bucket of a dashboard line agrees with its own count',
    },
  ],
]);

/** The English catalog, flattened. */
export function readEnglishCatalog(localesDir = LOCALES_DIR) {
  return flattenCatalog(JSON.parse(readFileSync(join(localesDir, 'en.json'), 'utf8')));
}

/** The base key of a plural family, or null when the key is not a category. */
export function pluralFamilyBase(key) {
  return pluralParts(key)?.base ?? null;
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
 * one is a call whose possible messages the audit cannot see.
 */
export function findUnlistedDynamicCalls(rootDir = SOURCE_DIR) {
  return unlistedDynamicCalls(auditTree(rootDir).calls);
}

/**
 * The counted keys — literal, or produced by a reviewed dynamic call — that
 * are neither a plural family in English nor a reviewed `NO_AGREEMENT` entry.
 * Empty on a healthy tree; every entry is a message whose count cannot select
 * a form.
 */
export function findCountlessFamilies(rootDir = SOURCE_DIR, localesDir = LOCALES_DIR) {
  return countlessFamilies(auditTree(rootDir).calls, readEnglishCatalog(localesDir));
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
  const report = [];
  const { calls, problems: unparsed } = auditTree(SOURCE_DIR);
  const english = readEnglishCatalog();

  for (const problem of unparsed) {
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
    const families = pluralFamilyBases(english);
    const owed = familiesOwedByEveryLocale(english);
    let totalKeys = 0;
    for (const tag of localeTags()) {
      if (tag === 'en') {
        continue;
      }
      let catalog;
      let categories;
      try {
        catalog = flattenCatalog(
          JSON.parse(readFileSync(join(LOCALES_DIR, `${tag}.json`), 'utf8'))
        );
        categories = new Intl.PluralRules(tag).resolvedOptions().pluralCategories;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`${tag}: cannot audit catalog: ${message}`);
        continue;
      }
      const localeFamilyBases = new Set();
      for (const key of catalog.keys()) {
        const base = pluralFamilyBase(key);
        if (base !== null) {
          localeFamilyBases.add(base);
        }
      }
      let flagged = 0;
      for (const family of families) {
        // A locale may keep the flat counted key and fall back to it when the
        // copy inflects no word of its own; it only owes categories once it
        // (or the audit's own rule) declares the family.
        const localeDeclared = localeFamilyBases.has(family);
        const mandatory = localeDeclared || owed.has(family);
        if (!mandatory) {
          continue;
        }
        if (categories.some(category => !catalog.has(`${family}_${category}`))) {
          flagged++;
        }
      }
      if (flagged > 0) {
        report.push(`${tag}: ${flagged} keys`);
        totalKeys += flagged;
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

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  run();
}
