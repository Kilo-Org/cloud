/**
 * Deleted-surface compliance gate.
 *
 * C3b–C5 replaced the flat/native/scoped-stop control modules and the legacy
 * recovery-reason constants with the canonical state core. A removed module or
 * constant must not reappear: a second representation of the same decision is
 * exactly what the cutover deleted. The gate asserts the module files stay gone
 * and that no source imports a removed module by its basename.
 *
 * `control-plane-session` is intentionally excluded from the basename scan: the
 * deleted `shared/control-plane-session.ts` shares its basename with the live
 * `router/control-plane-session.ts`. Its removal is covered by the file check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BASE = resolve(join(__dirname, '../..'));
const SELF = relative(BASE, join(__dirname, 'deleted-surface-compliance.test.ts'));
const ROOTS = ['src', 'test'];

/** Removed module paths under `src/`, relative to the package root. */
const REMOVED_MODULES = [
  'src/sandbox-control/control-recovery.ts',
  'src/sandbox-control/ensure-ready.ts',
  'src/sandbox-control/native-runtime-retirement.ts',
  'src/sandbox-control/physical-lifecycle.ts',
  'src/sandbox-control/reconciliation.ts',
  'src/sandbox-control/recovery-authority.ts',
  'src/sandbox-control/recovery-cleanup.ts',
  'src/sandbox-control/recovery-execution.ts',
  'src/sandbox-control/scoped-stop-maintenance.ts',
  'src/sandbox-control/status-projection.ts',
  'src/sandbox-control/allocation-view.ts',
  'src/sandbox-session/session-stop.ts',
  'src/sandbox-session/session-stop-lifecycle.ts',
  'src/sandbox-session/session-stop-progress.ts',
  'src/shared/control-plane-session.ts',
] as const;

/** Module basenames whose reintroduction is a deleted-surface violation. */
const REMOVED_BASENAMES = new Set(
  REMOVED_MODULES.map(path => path.replace(/\.ts$/, '').split('/').pop()!).filter(
    basename => basename !== 'control-plane-session'
  )
);

/** Removed legacy reason constants; the canonical stop reason replaces them. */
const REMOVED_SYMBOLS = ['RECOVERY_SETTLED_REAP_REASON', 'RECOVERY_CLEANUP_REASON'] as const;

const SPECIFIER_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  /import\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

/** Returns the relative import specifiers that name a removed module. */
export function findRemovedModuleImports(source: string): string[] {
  return importSpecifiers(source).filter(specifier => {
    if (!specifier.startsWith('.')) return false;
    const basename = specifier.replace(/\.js$/, '').split('/').pop() ?? '';
    return REMOVED_BASENAMES.has(basename);
  });
}

/** Returns the removed legacy reason constants named in `source`. */
export function findRemovedSymbols(source: string): string[] {
  return REMOVED_SYMBOLS.filter(name => new RegExp(`\\b${name}\\b`).test(source));
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

function scannedFiles(): string[] {
  return ROOTS.flatMap(root => sourceFiles(join(BASE, root))).filter(
    path => relative(BASE, path) !== SELF
  );
}

describe('deleted control surface stays deleted', () => {
  it('detects a removed module import and a removed reason constant', () => {
    expect(findRemovedModuleImports("import { x } from './recovery-cleanup.js';")).toEqual([
      './recovery-cleanup.js',
    ]);
    expect(
      findRemovedModuleImports("import type { y } from '../sandbox-control/physical-lifecycle';")
    ).toEqual(['../sandbox-control/physical-lifecycle']);
    expect(findRemovedSymbols('const reason = RECOVERY_SETTLED_REAP_REASON;')).toEqual([
      'RECOVERY_SETTLED_REAP_REASON',
    ]);
    // The live router module shares a basename with a deleted shared module.
    expect(
      findRemovedModuleImports("import { z } from '../router/control-plane-session.js';")
    ).toEqual([]);
  });

  it('keeps every removed module deleted', () => {
    const present = REMOVED_MODULES.filter(path => existsSync(resolve(BASE, path)));
    expect(present).toEqual([]);
  });

  it('no source file imports a removed module or names a removed reason constant', () => {
    const offenders = scannedFiles()
      .map(path => {
        const source = readFileSync(path, 'utf-8');
        return {
          path: relative(BASE, path),
          imports: findRemovedModuleImports(source),
          symbols: findRemovedSymbols(source),
        };
      })
      .filter(entry => entry.imports.length > 0 || entry.symbols.length > 0)
      .map(entry => `${entry.path}: ${[...entry.imports, ...entry.symbols].join(', ')}`);
    expect(offenders).toEqual([]);
  });
});
