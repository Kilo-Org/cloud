// One home for the Swift toolchain probe the local Apple module suites share.
//
// Each suite compiles and runs Swift checks against the sources it ships, so it
// needs the compiler it will invoke to be usable before it registers a test.
// macOS has no bare `swiftc` on PATH (the tool lives inside the active developer
// directory, which `xcrun` resolves), so its lookup goes through
// `xcrun --find`; every other platform uses `which`. Both lookups run inside one
// try/catch, and the tuple comes back only when the resolved path exists, so a
// host without a usable compiler skips those tests instead of failing them.
// eslint-disable-next-line import/no-nodejs-modules -- Test-only helper: these suites run under Node, never in the app bundle
import { execFileSync } from 'node:child_process';
// eslint-disable-next-line import/no-nodejs-modules -- Test-only helper: these suites run under Node, never in the app bundle
import { existsSync } from 'node:fs';

export type SwiftToolchain = readonly [command: string, ...compilerArgs: string[]];

export function swiftToolchain(): SwiftToolchain | undefined {
  const darwin = process.platform === 'darwin';
  try {
    const compilerPath = execFileSync(
      darwin ? 'xcrun' : 'which',
      darwin ? ['--find', 'swiftc'] : ['swiftc'],
      { encoding: 'utf8' }
    ).trim();
    if (compilerPath.length === 0 || !existsSync(compilerPath)) {
      return undefined;
    }
    return darwin ? ['xcrun', 'swiftc'] : ['swiftc'];
  } catch {
    return undefined;
  }
}
