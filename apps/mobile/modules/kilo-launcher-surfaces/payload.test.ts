import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

type SwiftToolchain = readonly [command: string, ...prefix: string[]];

// One availability rule for every platform: resolve the compiler that
// `runSwiftPayloadChecks` will invoke, and return the tuple only when the
// lookup finds an existing path. macOS has no bare `swiftc` on PATH, so its
// lookup goes through `xcrun --find`; every other platform uses `which`.
function swiftToolchain(): SwiftToolchain | undefined {
  const darwin = process.platform === 'darwin';
  try {
    const compilerPath = execFileSync(
      darwin ? 'xcrun' : 'which',
      darwin ? ['--find', 'swiftc'] : ['swiftc'],
      {
        encoding: 'utf8',
      }
    ).trim();
    if (compilerPath.length === 0 || !existsSync(compilerPath)) {
      return undefined;
    }
    return darwin ? ['xcrun', 'swiftc'] : ['swiftc'];
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
      fileURLToPath(new URL('ios/KiloLauncherSurfacesPayload.swift', import.meta.url)),
      fileURLToPath(new URL('tests/LauncherSurfacesPayloadTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The skip decision and the value the body receives come from the one probe
// result, so a host with no usable toolchain skips instead of throwing.
if (toolchain === undefined) {
  it.skip('executes the native launcher payload checks');
} else {
  it('executes the native launcher payload checks', () => {
    runSwiftPayloadChecks(toolchain);
  });
}
