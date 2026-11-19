import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

const moduleSource = readFileSync(
  new URL('ios/KiloAppleModelModule.swift', import.meta.url),
  'utf8'
);

const normalizedModuleSource = moduleSource.replaceAll(/\s+/g, ' ').replaceAll(/\s*\.\s*/g, '.');

// Every budget marker below must sit inside the function that owns it, so a
// marker cannot pass because a different function happens to use the same API.
// No marker is meant to hold anywhere in the module. A missing function fails
// the case here instead of matching an empty slice.
function swiftFunctionSource(name: string): string {
  const anchor = `func ${name}(`;
  const start = normalizedModuleSource.indexOf(anchor);
  if (start === -1) {
    throw new Error(`module has no func ${name}(`);
  }
  const end = normalizedModuleSource.indexOf('func ', start + anchor.length);
  return normalizedModuleSource.slice(start, end === -1 ? normalizedModuleSource.length : end);
}

type SwiftToolchain = readonly [command: string, ...compilerArgs: string[]];

// One availability rule for every platform: resolve the compiler the checks
// invoke, and return the tuple only when the lookup finds an existing path.
// macOS has no bare `swiftc` on PATH, so its lookup goes through
// `xcrun --find`; every other platform uses `which`.
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

type SwiftCheck = {
  readonly prefix: string;
  readonly binaryName: string;
  readonly sources: readonly string[];
};

function runSwiftChecks(
  [command, ...compilerArgs]: SwiftToolchain,
  { prefix, binaryName, sources }: SwiftCheck
): void {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const binary = join(directory, binaryName);
  try {
    execFileSync(command, [
      ...compilerArgs,
      '-parse-as-library',
      ...sources.map(source => fileURLToPath(new URL(source, import.meta.url))),
      '-o',
      binary,
    ]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('uses the counted transcript budget for generation and reported truncation', () => {
  const responseLimitSource = swiftFunctionSource('responseLimit');
  expect(responseLimitSource).toContain('model.tokenCount(for:');
  expect(responseLimitSource).toContain('AppleModelBudget.responseLimit');
  expect(responseLimitSource).toContain('reason: "context_window_exceeded"');

  expect(swiftFunctionSource('availability')).toContain('AppleModelBudget.outputCeiling');

  const inferSource = swiftFunctionSource('infer');
  expect(inferSource).toContain('options.maximumResponseTokens');
  expect(inferSource).toContain('usageSource == "reported"');
  expect(inferSource).toContain('outputTokens >= responseLimit');
  expect(inferSource).toContain('completion.stop = "maxTokens"');
});

// The skip decision and the compiler the body invokes come from the one probe
// result, so a host with no usable toolchain skips instead of throwing.
if (toolchain === undefined) {
  it.skip('executes the native budget boundary checks');
  it.skip('executes bounded native recovery checks');
} else {
  it('executes the native budget boundary checks', () => {
    runSwiftChecks(toolchain, {
      prefix: 'apple-model-budget-',
      binaryName: 'budget-tests',
      sources: ['ios/AppleModelBudget.swift', 'tests/AppleModelBudgetTests.swift'],
    });
  });

  it('executes bounded native recovery checks', () => {
    runSwiftChecks(toolchain, {
      prefix: 'apple-model-retry-',
      binaryName: 'retry-tests',
      sources: ['ios/AppleModelRetry.swift', 'tests/AppleModelRetryTests.swift'],
    });
  });
}
