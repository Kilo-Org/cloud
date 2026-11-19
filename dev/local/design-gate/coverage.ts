import fs from 'node:fs';
import path from 'node:path';

import {
  COVERAGE_STATES,
  linkTarget,
  type CoverageState,
  type ManifestRow,
  type RouteFile,
} from './batch-manifest';
import type { Platform } from './matrix';

/**
 * The screen × state × platform coverage map: one row per route file under
 * `apps/mobile/src/app` and platform, one cell per state. A cell lists how that
 * state is reached, separated by ` ; `:
 *   <batch> [force:<mode>] <link>   generated from the manifest (rewritten by --write)
 *   F:<dev link>  S:<seed topic>  B:<batch> <note>  L:<link>  note: <text>
 *                                   written by hand and kept across regeneration
 *   n/a: <reason>                   the screen has no such state by construction
 *   none                            nothing reaches the state yet
 */
export const DEFAULT_COVERAGE = path.join(import.meta.dirname, 'batches', 'coverage.tsv');
export const COVERAGE_COLUMNS = [
  'file',
  'screen',
  'source',
  'platform',
  ...COVERAGE_STATES,
] as const;
const PLATFORMS: readonly Platform[] = ['android', 'ios'];
const SEPARATOR = ' ; ';
const NONE = 'none';
const GENERATED = /^[A-Za-z0-9][A-Za-z0-9-]* (force:[a-z-]+ )?kiloapp:\/\//;

export type CoverageRow = Readonly<{
  file: string;
  screen: string;
  source: 'route' | 'dev-fixture';
  platform: Platform;
  cells: Readonly<Record<CoverageState, readonly string[]>>;
}>;

export class CoverageError extends Error {
  override name = 'CoverageError';
}

function emptyCells(): Record<CoverageState, string[]> {
  return {
    loading: [],
    empty: [],
    happy: [],
    'retryable-error': [],
    'non-retryable-error': [],
    'permission-denied': [],
    offline: [],
    'long-content': [],
  };
}

export function parseCoverage(text: string): CoverageRow[] {
  const [header, ...lines] = text.split('\n');
  if (header !== COVERAGE_COLUMNS.join('\t')) {
    throw new CoverageError(`coverage header must be: ${COVERAGE_COLUMNS.join(' <TAB> ')}`);
  }
  return lines
    .map((line, index) => ({ line, number: index + 2 }))
    .filter(({ line }) => line.trim() !== '' && !line.startsWith('#'))
    .map(({ line, number }) => {
      const fields = line.split('\t');
      if (fields.length !== COVERAGE_COLUMNS.length) {
        throw new CoverageError(`coverage line ${number}: ${fields.length} columns`);
      }
      const [file = '', screen = '', source, platform, ...states] = fields;
      if (source !== 'route' && source !== 'dev-fixture') {
        throw new CoverageError(`coverage line ${number}: source "${source}"`);
      }
      if (platform !== 'android' && platform !== 'ios') {
        throw new CoverageError(`coverage line ${number}: platform "${platform}"`);
      }
      const cells = emptyCells();
      COVERAGE_STATES.forEach((state, position) => {
        const value = states[position] ?? '';
        cells[state] = value === NONE || value === '' ? [] : value.split(SEPARATOR);
      });
      return { file, screen, source, platform, cells };
    });
}

export function formatCoverage(rows: readonly CoverageRow[]): string {
  const lines = rows.map(row =>
    [
      row.file,
      row.screen,
      row.source,
      row.platform,
      ...COVERAGE_STATES.map(state =>
        row.cells[state].length === 0 ? NONE : row.cells[state].join(SEPARATOR)
      ),
    ].join('\t')
  );
  return `${[COVERAGE_COLUMNS.join('\t'), ...lines].join('\n')}\n`;
}

export function generatedToken(row: ManifestRow): string {
  return [row.batch, ...(row.force === undefined ? [] : [`force:${row.force}`]), row.link].join(
    ' '
  );
}

/**
 * The map for the current route files and manifest: hand-written tokens of a
 * previous map are kept per file, platform and state; generated tokens are
 * recomputed from the manifest; rows of deleted route files are dropped.
 */
export function generateCoverage(
  routes: readonly RouteFile[],
  manifest: readonly ManifestRow[],
  previous: readonly CoverageRow[]
): CoverageRow[] {
  const kept = new Map(previous.map(row => [`${row.file}\t${row.platform}`, row]));
  const byFile = new Map<string, ManifestRow[]>();
  for (const row of manifest) {
    const file = linkTarget(routes, row.link).route?.file;
    if (file === undefined) continue;
    byFile.set(file, [...(byFile.get(file) ?? []), row]);
  }
  return routes.flatMap(route =>
    PLATFORMS.map(platform => {
      const old = kept.get(`${route.file}\t${platform}`);
      const cells = emptyCells();
      for (const state of COVERAGE_STATES) {
        const manual = (old?.cells[state] ?? []).filter(token => !GENERATED.test(token));
        const generated = (byFile.get(route.file) ?? [])
          .filter(row => row.state === state && row.platforms.includes(platform))
          .map(generatedToken);
        cells[state] = [...generated, ...manual];
      }
      return {
        file: route.file,
        screen: route.segments.join('/'),
        source: /fixture/.test(route.file) ? 'dev-fixture' : 'route',
        platform,
        cells,
      };
    })
  );
}

/**
 * Every way the committed map disagrees with the route files and manifest: a
 * route file without a row (a new screen that skipped coverage), a row whose
 * file is gone, and generated cells that no longer match the manifest.
 */
export function coverageProblems(
  routes: readonly RouteFile[],
  manifest: readonly ManifestRow[],
  committed: readonly CoverageRow[]
): string[] {
  const problems: string[] = [];
  const have = new Set(committed.map(row => `${row.file}\t${row.platform}`));
  const files = new Set(routes.map(route => route.file));
  for (const route of routes) {
    for (const platform of PLATFORMS) {
      if (!have.has(`${route.file}\t${platform}`)) {
        problems.push(`route ${route.file} has no ${platform} coverage row`);
      }
    }
  }
  for (const row of committed) {
    if (!files.has(row.file)) problems.push(`coverage row ${row.file} names no route file`);
  }
  if (problems.length > 0) return problems;
  const expected = formatCoverage(generateCoverage(routes, manifest, committed));
  if (expected !== formatCoverage(committed)) {
    problems.push('generated cells are stale; run `batches coverage --write`');
  }
  return problems;
}

export function readCoverage(file = DEFAULT_COVERAGE): CoverageRow[] {
  return fs.existsSync(file) ? parseCoverage(fs.readFileSync(file, 'utf8')) : [];
}
