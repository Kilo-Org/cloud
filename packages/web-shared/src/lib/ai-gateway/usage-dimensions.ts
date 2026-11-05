/**
 * Value domains for the usage dimension tables.
 *
 * `microdollar_usage_metadata` references these attributes through shared
 * lookup tables, so each table stores a declared, fixed set of values:
 * `editor_name` one of `EDITOR_NAME_VALUES`, `mode` one of `MODE_VALUES`, and
 * `system_prompt_prefix` a fixed-size key with `SYSTEM_PROMPT_PREFIX_BUCKETS`
 * possible values.
 *
 * Normalization runs in `toInsertableDbUsageRecord`, the single place that
 * builds `UsageMetaData` for every accounting transport. Request handling keeps
 * the header values as sent, because `x-kilocode-mode` also drives `kilo-auto`
 * routing and the bouncer usage event, and `determineFallbackFeature` reads the
 * prompt text in memory.
 */

import { createHash } from 'node:crypto';

/** Bucket for an editor that is not one of `EDITOR_NAME_VALUES`. */
export const OTHER_EDITOR_NAME = 'other';
/** Bucket for a mode that is not one of `MODE_VALUES`. */
export const OTHER_MODE = 'other';

/**
 * The editor families an `editor_name` value can collapse to. Mirrors the
 * editor list in `apps/web/src/lib/editorOptions.ts`, plus the names the
 * gateway clients send themselves: `Kilo CLI` (`DEFAULT_EDITOR_NAME`) and a
 * generic `jetbrains`. This package cannot import from `apps/web`.
 */
export const EDITOR_NAME_VALUES = [
  'vscode',
  'vscode-insiders',
  'cursor',
  'windsurf',
  'trae',
  'kilo-cli',
  'jetbrains',
  'intellij-idea',
  'appcode',
  'clion',
  'pycharm',
  'phpstorm',
  'rubymine',
  'webstorm',
  'rider',
  'goland',
  'rustrover',
  'datagrip',
  'dataspell',
] as const;

export type EditorName = (typeof EDITOR_NAME_VALUES)[number] | typeof OTHER_EDITOR_NAME;

/**
 * Slug prefixes that resolve to an editor family.
 *
 * The clients send an application name with its version appended
 * (`vscode.env.appName` plus `vscode.version` from the VS Code family,
 * `fullApplicationName` plus the build string from the JetBrains plugin), so
 * the match is on a prefix: a JetBrains code name such as
 * `Android Studio Ladybug` keeps the family, and an application version maps to
 * the same family.
 */
const EDITOR_SLUG_PREFIXES: ReadonlyArray<readonly [prefix: string, value: EditorName]> = (
  [
    ['visual-studio-code-insiders', 'vscode-insiders'],
    ['visual-studio-code', 'vscode'],
    ['vs-code', 'vscode'],
    ['vscode-insiders', 'vscode-insiders'],
    ['vscode', 'vscode'],
    ['cursor', 'cursor'],
    ['windsurf', 'windsurf'],
    ['trae', 'trae'],
    ['kilo-cli', 'kilo-cli'],
    ['jetbrains', 'jetbrains'],
    ['intellij-idea', 'intellij-idea'],
    ['appcode', 'appcode'],
    ['clion', 'clion'],
    ['pycharm', 'pycharm'],
    ['phpstorm', 'phpstorm'],
    ['rubymine', 'rubymine'],
    ['webstorm', 'webstorm'],
    ['rider', 'rider'],
    ['goland', 'goland'],
    ['rustrover', 'rustrover'],
    ['rustover', 'rustrover'],
    ['datagrip', 'datagrip'],
    ['dataspell', 'dataspell'],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Built-in agent names and legacy Kilo modes. Custom agent names are
 * caller-defined, so they collapse to `other`; add a built-in name here when a
 * client starts sending it.
 */
export const MODE_VALUES = [
  'build',
  'plan',
  'code',
  'architect',
  'ask',
  'debug',
  'general',
  'explore',
  'scout',
  'compaction',
  'title',
  'summary',
] as const;

export type Mode = (typeof MODE_VALUES)[number] | typeof OTHER_MODE;

/**
 * Number of distinct `system_prompt_prefix` values, and therefore the maximum
 * row count of that table. The key is a prefix of the digest, so the same
 * prompt text always maps to the same key.
 */
export const SYSTEM_PROMPT_PREFIX_BUCKETS = 1 << 16;

const SYSTEM_PROMPT_PREFIX_DIGEST_LENGTH = 4;

/** Trimmed, lowercased, version-free form of an editor name (`visual-studio-code`). */
function editorSlug(value: string | null): string | null {
  if (value === null) return null;
  const tokens = value.trim().split(/\s+/);
  const versionIndex = tokens.findIndex(token => /^[0-9]/.test(token));
  const name = (versionIndex === -1 ? tokens : tokens.slice(0, versionIndex)).join(' ');
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? null : slug;
}

/** Maps a client `x-kilocode-editorname` value onto `EDITOR_NAME_VALUES`. */
export function normalizeEditorName(value: string | null): EditorName | null {
  const slug = editorSlug(value);
  if (slug === null) return null;
  for (const [prefix, family] of EDITOR_SLUG_PREFIXES) {
    if (slug === prefix || slug.startsWith(`${prefix}-`)) return family;
  }
  return OTHER_EDITOR_NAME;
}

/** Maps a client `x-kilocode-mode` value onto `MODE_VALUES`. */
export function normalizeMode(value: string | null): Mode | null {
  if (value === null) return null;
  const mode = value.trim().toLowerCase();
  if (mode === '') return null;
  return (MODE_VALUES as readonly string[]).includes(mode) ? (mode as Mode) : OTHER_MODE;
}

/**
 * Maps a system prompt prefix to a fixed-size key with
 * `SYSTEM_PROMPT_PREFIX_BUCKETS` possible values. `sp-` marks the value as a
 * key.
 */
export function normalizeSystemPromptPrefix(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  const digest = createHash('sha256').update(value).digest('hex');
  return `sp-${digest.slice(0, SYSTEM_PROMPT_PREFIX_DIGEST_LENGTH)}`;
}
