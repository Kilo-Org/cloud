import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

type SwiftToolchain = readonly [command: string, ...prefix: string[]];

function swiftToolchain(): SwiftToolchain | undefined {
  if (process.platform === 'darwin') return ['xcrun', 'swiftc'];
  try {
    const swiftcPath = execFileSync('which', ['swiftc'], { encoding: 'utf8' }).trim();
    return swiftcPath.length > 0 && existsSync(swiftcPath) ? ['swiftc'] : undefined;
  } catch {
    return undefined;
  }
}

const toolchain = swiftToolchain();

function runSwiftPayloadChecks([command, ...prefix]: SwiftToolchain): void {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-surfaces-payload-'));
  const binary = join(directory, 'payload-tests');
  try {
    execFileSync(command, [
      ...prefix,
      '-parse-as-library',
      fileURLToPath(new URL('./ios/KiloLauncherSurfacesPayload.swift', import.meta.url)),
      fileURLToPath(new URL('./tests/LauncherSurfacesPayloadTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it.runIf(toolchain !== undefined)('executes the native launcher payload checks', () => {
  if (toolchain === undefined) throw new Error('checked only with a Swift toolchain on PATH');
  runSwiftPayloadChecks(toolchain);
});
