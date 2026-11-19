import fs from 'node:fs';
import path from 'node:path';

import { MATRIX_NAMES, type MatrixName, type Platform } from './matrix';

/**
 * The committed end-to-end pass: one row per deep link, grouped into batches the
 * runner opens in one gate run each. Rows of one batch share its tier, phase and
 * matrix. Append a row to add a link; regenerate the expected columns with
 * `batches expect --write` and the coverage map with `batches coverage --write`.
 */
export const DEFAULT_MANIFEST = path.join(import.meta.dirname, 'batches', 'manifest.tsv');
export const APP_DIR = path.join(import.meta.dirname, '..', '..', '..', 'apps/mobile/src/app');

export const MANIFEST_COLUMNS = [
  'batch',
  'tier',
  'phase',
  'matrix',
  'platforms',
  'state',
  'force',
  'link',
  'kind',
  'screen',
] as const;

export const COVERAGE_STATES = [
  'loading',
  'empty',
  'happy',
  'retryable-error',
  'non-retryable-error',
  'permission-denied',
  'offline',
  'long-content',
] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** Modes of the dev-only `kiloapp:///dev/force-state/<mode>?next=<link>` override. */
export const FORCE_MODES = [
  'loading',
  'retryable',
  'non-retryable',
  'permission',
  'offline',
] as const;
export type ForceMode = (typeof FORCE_MODES)[number];
export const FORCE_CLEAR_LINK = 'kiloapp:///dev/force-state/clear';

export const PHASES = ['signed-in', 'signed-out'] as const;
export type Phase = (typeof PHASES)[number];
export const TIERS = ['T1', 'T2'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * What a link must settle on:
 *   screen     `env.screen` equals the row's screen, and the dump is not a
 *              not-found, invalid-route or error-boundary state
 *   not-found  the dump is a not-found or invalid-route state (intended absence)
 *   error      the dump is an error state (a seeded fault)
 *   clean      no screen assertion (a link that navigates itself); only the
 *              error boundary fails
 */
export const EXPECT_KINDS = ['screen', 'not-found', 'error', 'clean'] as const;
export type ExpectKind = (typeof EXPECT_KINDS)[number];

export type ManifestRow = Readonly<{
  line: number;
  batch: string;
  tier: Tier;
  phase: Phase;
  matrix: MatrixName;
  platforms: readonly Platform[];
  state: CoverageState;
  force?: ForceMode;
  link: string;
  kind: ExpectKind;
  screen: string;
}>;

export type Batch = Readonly<{
  id: string;
  tier: Tier;
  phase: Phase;
  matrix: MatrixName;
  rows: readonly ManifestRow[];
}>;

export class ManifestError extends Error {
  override name = 'ManifestError';
}

function member<T extends string>(
  allowed: readonly T[],
  value: string,
  what: string,
  line: number
): T {
  const match = allowed.find(candidate => candidate === value);
  if (match === undefined) {
    throw new ManifestError(`line ${line}: ${what} "${value}" is not one of ${allowed.join(', ')}`);
  }
  return match;
}

const EMPTY = '-';

export function parseManifest(text: string): ManifestRow[] {
  const lines = text.split('\n');
  const header = lines[0]?.split('\t') ?? [];
  if (header.join('\t') !== MANIFEST_COLUMNS.join('\t')) {
    throw new ManifestError(`header must be: ${MANIFEST_COLUMNS.join(' <TAB> ')}`);
  }
  const rows: ManifestRow[] = [];
  const batches = new Map<string, ManifestRow>();
  const seen = new Set<string>();
  lines.slice(1).forEach((raw, index) => {
    const line = index + 2;
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const fields = raw.split('\t');
    if (fields.length !== MANIFEST_COLUMNS.length) {
      throw new ManifestError(
        `line ${line}: ${fields.length} columns, expected ${MANIFEST_COLUMNS.length}`
      );
    }
    const [batch, tier, phase, matrix, platforms, state, force, link, kind, screen] = fields;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(batch ?? '')) {
      throw new ManifestError(`line ${line}: batch id "${batch}" must be [A-Za-z0-9-]`);
    }
    if (!(link ?? '').startsWith('kiloapp://')) {
      throw new ManifestError(`line ${line}: link must start with kiloapp://`);
    }
    const row: ManifestRow = {
      line,
      batch: batch ?? '',
      tier: member(TIERS, tier ?? '', 'tier', line),
      phase: member(PHASES, phase ?? '', 'phase', line),
      matrix: member(MATRIX_NAMES, matrix ?? '', 'matrix', line),
      platforms: (platforms ?? '')
        .split(',')
        .map(value => member(['android', 'ios'] as const, value, 'platform', line)),
      state: member(COVERAGE_STATES, state ?? '', 'state', line),
      ...(force === EMPTY ? {} : { force: member(FORCE_MODES, force ?? '', 'force', line) }),
      link: link ?? '',
      kind: member(EXPECT_KINDS, kind ?? '', 'kind', line),
      screen: screen === EMPTY ? '' : (screen ?? ''),
    };
    const key = `${row.batch}\t${row.force ?? ''}\t${row.link}`;
    if (seen.has(key)) throw new ManifestError(`line ${line}: duplicate link in ${row.batch}`);
    seen.add(key);
    const first = batches.get(row.batch);
    if (first === undefined) batches.set(row.batch, row);
    else if (first.tier !== row.tier || first.phase !== row.phase || first.matrix !== row.matrix) {
      throw new ManifestError(
        `line ${line}: ${row.batch} rows disagree on tier, phase or matrix (line ${first.line})`
      );
    }
    rows.push(row);
  });
  return rows;
}

export function formatManifest(rows: readonly ManifestRow[]): string {
  const body = rows.map(row =>
    [
      row.batch,
      row.tier,
      row.phase,
      row.matrix,
      row.platforms.join(','),
      row.state,
      row.force ?? EMPTY,
      row.link,
      row.kind,
      row.screen === '' ? EMPTY : row.screen,
    ].join('\t')
  );
  return `${[MANIFEST_COLUMNS.join('\t'), ...body].join('\n')}\n`;
}

export function readManifest(file = DEFAULT_MANIFEST): ManifestRow[] {
  return parseManifest(fs.readFileSync(file, 'utf8'));
}

/** Batches in manifest order; a batch's rows keep their manifest order. */
export function groupBatches(rows: readonly ManifestRow[]): Batch[] {
  const batches = new Map<string, ManifestRow[]>();
  for (const row of rows) {
    const list = batches.get(row.batch) ?? [];
    list.push(row);
    batches.set(row.batch, list);
  }
  return [...batches.entries()].map(([id, list]) => {
    const [first] = list;
    if (first === undefined) throw new ManifestError(`batch ${id} has no rows`);
    return { id, tier: first.tier, phase: first.phase, matrix: first.matrix, rows: list };
  });
}

export function parseShard(value: string): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || count < 1 || index < 1 || index > count) {
    throw new ManifestError(`--shard must be i/n with 1 <= i <= n, got "${value}"`);
  }
  return { index, count };
}

/**
 * The batches of shard `index` of `count`. Batches are ordered by id before they
 * are dealt round-robin, so the split depends only on the set of batch ids: a
 * reordered manifest or another machine selects the same shard, and the shards
 * of one count partition the batches.
 */
export function shardBatches<T extends { id: string }>(
  batches: readonly T[],
  shard: { index: number; count: number }
): T[] {
  return [...batches]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((_, position) => position % shard.count === shard.index - 1);
}

// --- Seed-id templates -------------------------------------------------------

/** `{{seed:<step>.<key>}}`: a value the `seed-all` step `<step>` printed as `<key>`. */
const TEMPLATE = /\{\{([^{}]*)\}\}/g;
const SEED_REFERENCE = /^seed:([a-z0-9-]+)\.([A-Za-z0-9]+)$/;

export type SeedValue = string | number | boolean | null;
export type SeedMap = Readonly<{
  email: string;
  createdAt: string;
  steps: Readonly<
    Record<
      string,
      Readonly<{ topic: string; ok: boolean; values: Record<string, SeedValue>; error?: string }>
    >
  >;
}>;

export class TemplateError extends Error {
  override name = 'TemplateError';
}

export function templateReferences(link: string): string[] {
  return [...link.matchAll(TEMPLATE)].map(match => match[1] ?? '');
}

/**
 * Replaces every `{{seed:<step>.<key>}}` with the seeded value. A reference the
 * map cannot answer (a step that failed or never ran, or a key it did not
 * print) is an error naming every missing reference, never a link with a hole.
 */
export function resolveTemplates(link: string, seeds: SeedMap | undefined): string {
  const missing: string[] = [];
  const resolved = link.replace(TEMPLATE, (whole, reference: string) => {
    const match = SEED_REFERENCE.exec(reference);
    if (match === null) {
      missing.push(`${whole} (not a {{seed:<step>.<key>}} reference)`);
      return whole;
    }
    const [, step = '', key = ''] = match;
    const entry = seeds?.steps[step];
    const value = entry?.ok === true ? entry.values[key] : undefined;
    if (value === undefined || value === null || value === '') {
      const why =
        seeds === undefined
          ? 'no --seeds map'
          : entry === undefined
            ? `seed step ${step} did not run`
            : !entry.ok
              ? `seed step ${step} failed`
              : `seed step ${step} printed no ${key}`;
      missing.push(`${whole} (${why})`);
      return whole;
    }
    return encodeURIComponent(String(value));
  });
  if (missing.length > 0) {
    throw new TemplateError(`unresolved seed reference(s) in ${link}: ${missing.join(', ')}`);
  }
  return resolved;
}

/** The app link a row opens: its own link, or the force-state override around it. */
export function targetLink(row: ManifestRow, resolvedLink: string): string {
  if (row.force === undefined) return resolvedLink;
  return `kiloapp:///dev/force-state/${row.force}?next=${encodeURIComponent(resolvedLink)}`;
}

// --- Expected outcomes -------------------------------------------------------

export type RouteFile = Readonly<{ file: string; segments: readonly string[] }>;

/**
 * Every screen file below `apps/mobile/src/app`: `_layout`, `+` special files and
 * tests are not screens. `segments` follows the gate's `screen` convention:
 * groups kept, dynamic segments kept as `[param]`, `index` dropped.
 */
export function listRouteFiles(appDir = APP_DIR): RouteFile[] {
  const routes: RouteFile[] = [];
  const walk = (dir: string, prefix: readonly string[]) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('__tests__')) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...prefix, entry.name]);
        continue;
      }
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) continue;
      if (entry.name.startsWith('+') || entry.name === '_layout.tsx') continue;
      const name = entry.name.replace(/\.tsx$/, '');
      const segments = name === 'index' ? prefix : [...prefix, name];
      if (segments.length === 0) continue;
      routes.push({ file: [...prefix, entry.name].join('/'), segments });
    }
  };
  walk(appDir, []);
  return routes;
}

const dynamic = (part: string) => part.startsWith('[');

function matches(route: readonly string[], segments: readonly string[]): boolean {
  if (route.length !== segments.length) return false;
  return route.every((part, index) => dynamic(part) || part === segments[index]);
}

export function resolveRoute(
  routes: readonly RouteFile[],
  segments: readonly string[]
): RouteFile | undefined {
  const hits = routes.filter(route => matches(route.segments, segments));
  const exact = hits.find(route => route.segments.every((part, index) => part === segments[index]));
  if (exact !== undefined) return exact;
  const count = (route: RouteFile) => route.segments.filter(dynamic).length;
  return [...hits].sort((a, b) => count(a) - count(b))[0];
}

/**
 * Development links `+native-intent.tsx` handles: the route they show (with `$n`
 * from the pattern), and `self` for a link whose handler navigates by itself
 * (a bridge-backed sheet or a copy surface), so the settled screen is not
 * asserted, though the coverage map still attributes the link to that route.
 */
const DEV_ROUTES: readonly (readonly [RegExp, string, 'self'?])[] = [
  [/^dev\/home-fixture\//, '(app)/(tabs)/(0_home)'],
  [/^dev\/instance-picker-fixture\//, '(app)/agent-chat/instance-picker', 'self'],
  [/^dev\/account-picker-sheet-fixture/, '(app)/account-picker-sheet-fixture', 'self'],
  [/^dev\/pr-review-copy-fixture\//, '(auth)/pr-review-copy-fixture', 'self'],
  [
    /^dev\/organization-invite-member-fixture/,
    '(app)/(tabs)/(3_profile)/organization/invite-member',
    'self',
  ],
  [/^dev\/locked-keychain\//, '', 'self'],
  [
    /^dev\/security-agent-single-route-fixture\/[^/]+\/settings\/notifications$/,
    '(app)/security-agent/[scope]/settings/notifications',
  ],
  [/^dev\/pr-review-entry-fixture/, '(app)/pr-review-entry-fixture'],
  [/^dev\/button-label-fixture/, 'button-label-fixture'],
  [/^dev\/session-row-fixture/, '(auth)/session-row-fixture'],
  [/^dev\/system-search-unresolved-fixture/, '(app)/system-search-unresolved-fixture'],
  [/^dev\/save-profile-sheet-fixture/, '(app)/save-profile-sheet-fixture'],
  [/^dev\/transcript-style-fixture/, '(auth)/transcript-style-fixture'],
  [/^dev\/part-detail-transition-fixture/, '(auth)/part-detail-transition-fixture'],
  [/^dev\/attachment-chip-fixture/, '(app)/attachment-chip-fixture'],
  [/^dev\/preparation-copy-fixture/, '(app)/preparation-copy-fixture'],
  [/^dev\/new-session-plan-refusal-fixture/, '(app)/new-session-plan-refusal-fixture'],
  [/^dev\/low-balance-alert-refusal-fixture/, '(app)/low-balance-alert-refusal-fixture'],
  [
    /^dev\/transcript-(credits-failure|readonly-failure|execution-failure|preparation-failure|failure|terminal-failure|undelivered)-fixture/,
    '(app)/transcript-$1-fixture',
  ],
  [/^dev\/agent-chat-fixture/, '(app)/agent-chat-fixture'],
  [/^dev\/auth-switch-fixture/, '(app)/auth-switch-fixture'],
  [/^dev\/render-recovery-fixture\//, '(app)/render-recovery-fixture'],
  [/^dev\/question-card-fixture/, '(auth)/question-card-fixture'],
  [/^dev\/settings-confirm-fixture/, '(auth)/settings-confirm-fixture'],
  [/^dev\/security-agent-reauthorize-fixture/, '(auth)/security-agent-reauthorize-fixture'],
  [/^dev\/model-picker-fixture\/multiple-providers/, '(app)/agent-chat/model-picker'],
  [/^dev\/profile-picker-fixture/, '(app)/agent-chat/profile-picker'],
  [/^dev\/organization-invoices-fixture/, '(app)/(tabs)/(3_profile)/organization/invoices-fixture'],
  [/^dev\/personal-invoices-fixture\//, '(app)/(tabs)/(3_profile)/personal-invoices-fixture'],
  [/^dev\/credits-pack-prices-fixture/, '(app)/credits-pack-prices-fixture'],
  [/^dev\/local-failure-copy-fixture\//, '(app)/local-failure-copy-fixture'],
  [/^dev\/gguf-retry-fixture/, '(app)/gguf-retry-fixture'],
  [/^dev\/header-balance-fixture/, '(app)/header-balance-fixture'],
];

export function linkSegments(link: string): string[] {
  const [pathPart = ''] = link.replace(/^kiloapp:\/\/\/?/, '').split(/[?#]/);
  return pathPart.split('/').filter(Boolean);
}

export type LinkTarget = Readonly<{ route?: RouteFile; asserted: boolean }>;

/** The route file a link opens, and whether its settled screen can be asserted. */
export function linkTarget(routes: readonly RouteFile[], link: string): LinkTarget {
  const raw = linkSegments(link).join('/');
  if (!raw.startsWith('dev/')) {
    const route = resolveRoute(routes, linkSegments(link));
    return { route, asserted: route !== undefined };
  }
  for (const [pattern, target, navigation] of DEV_ROUTES) {
    const match = pattern.exec(raw);
    if (match === null) continue;
    const name = target.replace(/\$(\d)/g, (_, group: string) => match[Number(group)] ?? '');
    const route = name === '' ? undefined : resolveRoute(routes, name.split('/'));
    return { route, asserted: route !== undefined && navigation !== 'self' };
  }
  return { asserted: false };
}

/**
 * The expected columns a row's link implies. An authored `not-found` or `error`
 * kind is intent the route tree cannot know, so it is kept; every other row is
 * a screen when its link resolves to a route file the link shows by itself,
 * and `clean` otherwise.
 */
export function expectedOutcome(
  routes: readonly RouteFile[],
  row: Pick<ManifestRow, 'link' | 'kind'>
): { kind: ExpectKind; screen: string } {
  const target = linkTarget(routes, row.link);
  const screen = target.route?.segments.join('/') ?? '';
  if (row.kind === 'not-found' || row.kind === 'error') return { kind: row.kind, screen };
  return target.asserted ? { kind: 'screen', screen } : { kind: 'clean', screen: '' };
}

// --- Settled-state check (the old check-batch.mjs) -------------------------

const NOT_FOUND = [
  /^page not found$/i,
  /^not found$/i,
  /not found\.$/i,
  /may have been removed or is no longer available/i,
  /this link is no longer valid/i,
  // The share gate's stale-link state has no testID, so its copy is the verdict.
  /^share unavailable$/i,
  /send it again from the app you shared from/i,
];
// The root boundary and the runtime error screen both render these; the Home
// tab's inline "Something went wrong" card is a state, not a boundary.
const ERROR_BOUNDARY = [/render error/i, /maximum update depth/i, /cannot read propert/i];
const BOUNDARY_PHRASE = /^please try again\.?$/i;
// A tab root stays mounted under a pushed screen and its inline cards carry the
// boundary's sentence, so that sentence alone counts only on a small tree.
const BOUNDARY_TREE_LIMIT = 120;

export type DumpState = { notFound: boolean; errorBoundary: boolean; sample: string[] };

export function classifyDump(nodes: readonly { text?: string; label?: string }[]): DumpState {
  const texts = nodes
    .flatMap(node => [node.text, node.label])
    .filter((text): text is string => typeof text === 'string');
  const trimmed = texts.map(text => text.trim());
  return {
    notFound: trimmed.some(text => NOT_FOUND.some(pattern => pattern.test(text))),
    errorBoundary:
      trimmed.some(text => ERROR_BOUNDARY.some(pattern => pattern.test(text))) ||
      (trimmed.some(text => BOUNDARY_PHRASE.test(text)) && nodes.length < BOUNDARY_TREE_LIMIT),
    sample: texts.slice(0, 6),
  };
}

/** Why a settled dump does not meet its row, or undefined when it does. */
export function expectationMismatch(
  want: Pick<ManifestRow, 'kind' | 'screen'>,
  actualScreen: string,
  state: DumpState
): string | undefined {
  switch (want.kind) {
    case 'screen':
      if (actualScreen !== want.screen)
        return `screen ${JSON.stringify(actualScreen)} != ${JSON.stringify(want.screen)}`;
      if (state.notFound) return 'settled on a not-found state';
      if (state.errorBoundary) return 'settled on the error boundary';
      return undefined;
    case 'error':
      return state.errorBoundary ? undefined : 'expected an error state, the screen rendered';
    case 'not-found':
      return state.notFound ? undefined : 'expected a not-found state, the screen rendered';
    case 'clean':
      return state.errorBoundary ? 'settled on the error boundary' : undefined;
  }
}
