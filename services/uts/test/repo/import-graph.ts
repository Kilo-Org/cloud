import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Relative specifiers of static imports, re-exports and dynamic imports in a TypeScript module. */
const RELATIVE_IMPORT = /(?:\bfrom\s+|\bimport\s*\(?\s*)'(\.{1,2}\/[^']+)'/g;

function resolveModule(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, resolve(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate;
  }
  throw new Error(`${fromFile}: cannot resolve ${specifier}`);
}

/**
 * Every module of the service that `entry` reaches through relative imports, `entry` included, as
 * absolute paths. Package imports (`@kilocode/...`) are not followed.
 */
export function importClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [resolve(entry)];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      const specifier = match[1];
      if (specifier !== undefined) pending.push(resolveModule(file, specifier));
    }
  }
  return seen;
}
