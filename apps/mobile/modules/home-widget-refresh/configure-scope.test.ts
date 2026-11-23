/* eslint-disable import/no-nodejs-modules -- the compile check shells out to the Swift toolchain, which only a Node test can do */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

const CANDIDATES: [string, ...string[]][] = [['swiftc'], ['xcrun', 'swiftc']];

function swiftCompiler(): [string, ...string[]] | null {
  for (const candidate of CANDIDATES) {
    const [command, ...args] = candidate;
    try {
      execFileSync(command, [...args, '--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const compiler = swiftCompiler();

it.runIf(compiler !== null)('retires the previous scope only when configure replaces it', () => {
  const swift = compiler;
  if (swift === null) {
    throw new Error('no Swift compiler on PATH');
  }
  const [command, ...swiftArgs] = swift;
  const directory = mkdtempSync(join(tmpdir(), 'home-widget-configure-scope-'));
  const binary = join(directory, 'configure-scope-tests');
  try {
    execFileSync(command, [
      ...swiftArgs,
      '-parse-as-library',
      fileURLToPath(new URL('ios/HomeWidgetConfigureScope.swift', import.meta.url)),
      fileURLToPath(new URL('tests/HomeWidgetConfigureScopeTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    const output = execFileSync(binary, { encoding: 'utf8' });
    expect(output).toContain('HomeWidgetConfigureScope: all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
