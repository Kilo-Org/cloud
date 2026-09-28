/**
 * Legacy quarantine compliance gate. The frozen legacy decoders under
 * `sandbox-state/persist/legacy/` may be imported only by
 * `sandbox-state/persist/load.ts`; every other external importer would create a
 * second legacy dependency that the cutover cannot delete.
 *
 * Imports *inside* the legacy directory (a sibling decoder sharing a helper) stay
 * inside the quarantine and are explicitly allowed; they are not a second
 * external dependency. The scanner resolves each module specifier (static import,
 * side-effect import, dynamic import, `require`, extensionless, `.ts`, relative
 * sibling) to a real file so a new dependency cannot hide behind a spelling.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(join(__dirname, '..', '..', '..'), 'src');
const LEGACY_DIR = resolve(SRC, 'sandbox-state', 'persist', 'legacy');
const ALLOWED_IMPORTER = 'sandbox-state/persist/load.ts';

const SPECIFIER_PATTERNS = [
  /from\s+['"]([^'"]+)['"]/g,
  // Side-effect import: `import './legacy/allocation.js';`
  /import\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

// Backwards-compatible alias used by earlier revisions of this gate.
const specifiers = importSpecifiers;

/** Resolve a relative specifier to an existing `.ts` file, if one exists. */
export function resolveSpecifier(fileDir: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(fileDir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.js`,
    base.replace(/\.js$/, '.ts'),
    join(base, 'index.ts'),
  ];
  return candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
}

export function insideLegacy(filePath: string): boolean {
  const rel = relative(LEGACY_DIR, filePath);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

export type SourceFile = { path: string; source: string };
export type ImportResolution = (importerPath: string, specifier: string) => string | undefined;

export type ImporterClass =
  | { kind: 'prohibited'; specifier: string }
  | { kind: 'legacy-internal' }
  | { kind: 'none' };

/**
 * Classify one file's imports. A file inside the legacy directory importing a
 * sibling stays inside the quarantine; a file outside it importing legacy is
 * prohibited unless the caller's allowlist covers it.
 */
export function classifyImporter(file: SourceFile, resolveImport: ImportResolution): ImporterClass {
  const importerInsideLegacy = insideLegacy(file.path);
  for (const specifier of importSpecifiers(file.source)) {
    const resolved = resolveImport(file.path, specifier);
    if (resolved === undefined || !insideLegacy(resolved)) continue;
    if (importerInsideLegacy) return { kind: 'legacy-internal' };
    return { kind: 'prohibited', specifier };
  }
  return { kind: 'none' };
}

function normalize(filePath: string): string {
  return relative(SRC, filePath).split(sep).join('/');
}

export function prohibitedImporters(
  files: readonly SourceFile[],
  resolveImport: ImportResolution,
  allowed: readonly string[]
): string[] {
  const allowedSet = new Set(allowed);
  return files
    .filter(
      file =>
        !allowedSet.has(normalize(file.path)) &&
        classifyImporter(file, resolveImport).kind === 'prohibited'
    )
    .map(file => normalize(file.path))
    .sort();
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const SCANNER_FILE = resolve(__dirname, 'legacy-quarantine.test.ts');

function repositoryFiles(): SourceFile[] {
  // The scanner's own fixtures contain specifier literals; scanning them would be
  // self-referential, so the gate excludes only this file.
  return walk(SRC)
    .filter(path => path !== SCANNER_FILE)
    .map(path => ({ path, source: readFileSync(path, 'utf-8') }));
}

describe('legacy decoder quarantine', () => {
  it('resolves every import form into the legacy directory', () => {
    const legacyFile = join(LEGACY_DIR, 'session.ts');
    const forms = [
      './allocation.js',
      './allocation',
      './allocation.ts',
      '../legacy/allocation.js',
      '../legacy/allocation',
    ];
    for (const form of forms) {
      const resolved = resolveSpecifier(dirname(legacyFile), form);
      expect(resolved, form).toBeDefined();
      expect(insideLegacy(resolved!), form).toBe(true);
    }
  });

  it('detects side-effect, dynamic, require and extensionless spellings', () => {
    const sideEffect = specifiers("import './legacy/allocation.js';");
    const dynamic = specifiers("void import('./allocation.js');");
    const required = specifiers("const x = require('./allocation');");
    const extensionless = specifiers("import { x } from './allocation';");
    expect(sideEffect).toEqual(['./legacy/allocation.js']);
    for (const source of [dynamic, required, extensionless]) {
      expect(source).toHaveLength(1);
    }
  });

  it('flags prohibited importers and allows legacy-internal and allowlisted ones', () => {
    const legacySibling = join(LEGACY_DIR, 'allocation.ts');
    const resolveImport: ImportResolution = (_importer, specifier) =>
      specifier.includes('legacy/allocation') ||
      specifier === './allocation' ||
      specifier === './allocation.js'
        ? legacySibling
        : undefined;
    const files: SourceFile[] = [
      { path: join(SRC, 'sandbox-state', 'evil.ts'), source: "import './legacy/allocation.js';" },
      {
        path: join(SRC, 'sandbox-state', 'dynamic.ts'),
        source: "void import('./legacy/allocation.js');",
      },
      {
        path: join(SRC, 'sandbox-state', 'required.ts'),
        source: "const x = require('./legacy/allocation.js');",
      },
      {
        path: join(SRC, 'sandbox-state', 'static.ts'),
        source: "import { x } from './legacy/allocation';",
      },
      { path: join(LEGACY_DIR, 'session.ts'), source: "import './allocation.js';" },
      {
        path: join(SRC, 'sandbox-state', 'persist', 'load.ts'),
        source: "import { x } from './legacy/allocation.js';",
      },
      { path: join(SRC, 'sandbox-state', 'clean.ts'), source: "import { x } from './model.js';" },
    ];
    expect(prohibitedImporters(files, resolveImport, [ALLOWED_IMPORTER])).toEqual([
      'sandbox-state/dynamic.ts',
      'sandbox-state/evil.ts',
      'sandbox-state/required.ts',
      'sandbox-state/static.ts',
    ]);
    // The scanner actually classifies each fixture, so a rule regression fails here.
    expect(classifyImporter(files[1], resolveImport)).toEqual({
      kind: 'prohibited',
      specifier: './legacy/allocation.js',
    });
    expect(classifyImporter(files[4], resolveImport).kind).toBe('legacy-internal');
    expect(classifyImporter(files[6], resolveImport).kind).toBe('none');
  });

  it('only persist/load.ts imports persist/legacy/', () => {
    const files = repositoryFiles();
    expect(
      prohibitedImporters(
        files,
        (importer, specifier) => resolveSpecifier(dirname(importer), specifier),
        [ALLOWED_IMPORTER]
      )
    ).toEqual([]);
  });
});
