import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

import { swiftToolchain, type SwiftToolchain } from '../../src/test/swift-toolchain';

const toolchain = swiftToolchain();

function runSwiftPayloadChecks([command, ...compilerArgs]: SwiftToolchain): void {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-surfaces-payload-'));
  const binary = join(directory, 'payload-tests');
  try {
    execFileSync(command, [
      ...compilerArgs,
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

// The skip decision and the compiler the body receives come from the one probe
// result, so a host with no usable toolchain skips instead of throwing.
if (toolchain === undefined) {
  it.skip('executes the native launcher payload checks');
} else {
  it('executes the native launcher payload checks', () => {
    runSwiftPayloadChecks(toolchain);
  });
}
