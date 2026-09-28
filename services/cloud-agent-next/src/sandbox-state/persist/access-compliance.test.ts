/**
 * Raw storage key compliance gate.
 *
 * `persist/access.ts` is the only module that names the two raw aggregate keys.
 * No other production module or test may hardcode them, alias them, or reach
 * storage through them, so C3/C4 can swap the persisted shapes behind the
 * accessor without touching call sites.
 *
 * The detector is factored out so negative fixtures can prove it fails.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const BASE = resolve(join(__dirname, '../../..'));
const SELF = relative(BASE, join(__dirname, 'access-compliance.test.ts'));
const KEY_OWNER = 'src/sandbox-state/persist/access.ts';
const ROOTS = ['src', 'test'];

const RAW_KEYS = ['physical_record', 'session_messages'];
const KEY_NAMES = [
  'ALLOCATION_RECORD_KEY',
  'SESSION_MESSAGES_KEY',
  'LEGACY_ALLOCATION_KEY',
  'SESSION_KEY',
];

/** Returns a description of every raw-key violation in `source`. */
export function findRawKeyViolations(source: string): string[] {
  const violations: string[] = [];
  for (const key of RAW_KEYS) {
    if (new RegExp(`['"\`]${key}['"\`]`).test(source)) violations.push(`quoted literal ${key}`);
    if (new RegExp(`(?<![.\\w'"\`])${key}\\s*:`).test(source)) violations.push(`object key ${key}`);
  }
  for (const name of KEY_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(source)) violations.push(`key identifier ${name}`);
  }
  return violations;
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
  return ROOTS.flatMap(root => sourceFiles(join(BASE, root))).filter(path => {
    const rel = relative(BASE, path);
    return rel !== SELF && rel !== KEY_OWNER;
  });
}

describe('raw storage key compliance gate', () => {
  it('no module hardcodes, aliases or reaches through the raw aggregate keys', () => {
    const offenders = scannedFiles()
      .map(path => ({
        path: relative(BASE, path),
        violations: findRawKeyViolations(readFileSync(path, 'utf-8')),
      }))
      .filter(entry => entry.violations.length > 0)
      .map(entry => `${entry.path}: ${entry.violations.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it.each([
    `const key = 'physical_record';`,
    `const key = "session_messages";`,
    'const key = `physical_record`;',
    'const ALLOCATION_RECORD_KEY = 1;',
    'const SESSION_MESSAGES_KEY = 1;',
    'const LEGACY_ALLOCATION_KEY = 1;',
    'const SESSION_KEY = 1;',
    `const SESSION_KEY = 'session_messages';`,
    'export { raw as SESSION_KEY };',
    'const values = { physical_record: 1 };',
    'const values = { session_messages: 1 };',
  ])('flags %s', source => {
    expect(findRawKeyViolations(source)).not.toEqual([]);
  });

  it.each([
    `const values = seedSessionValue({}, []);`,
    `const record = await readAllocationRecord(storage);`,
    `const key = 'sandbox_allocation_state';`,
    `// the allocation record and the session messages`,
    `const attachedSessionKey = 'terminal_attached_session';`,
  ])('accepts %s', source => {
    expect(findRawKeyViolations(source)).toEqual([]);
  });
});
