import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as importEntryPoint from './index';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoots = [here, join(here, '..', 'contracts')];

const FORBIDDEN_SPECIFIERS = [/^drizzle-orm($|\/)/, /^@trpc\/server($|\/)/, /^@kilocode\/db$/];

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => join(directory, name));
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe('import module browser safety', () => {
  test('exposes the subpath entry point', () => {
    expect(typeof importEntryPoint.parseLocalConfigArchive).toBe('function');
    expect(typeof importEntryPoint.decodeConfigArchive).toBe('function');
  });

  test('never imports drizzle-orm, @trpc/server, or the @kilocode/db root', () => {
    const offenders: string[] = [];
    for (const directory of sourceRoots) {
      for (const file of listSourceFiles(directory)) {
        const source = readFileSync(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (FORBIDDEN_SPECIFIERS.some(pattern => pattern.test(specifier))) {
            offenders.push(`${file}: ${specifier}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
