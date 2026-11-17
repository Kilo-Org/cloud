import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

const moduleSource = readFileSync(
  new URL('./ios/KiloAppleModelModule.swift', import.meta.url),
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
  if (start === -1) throw new Error(`module has no func ${name}(`);
  const end = normalizedModuleSource.indexOf('func ', start + anchor.length);
  return normalizedModuleSource.slice(start, end === -1 ? normalizedModuleSource.length : end);
}

function runSwiftChecks(prefix: string, binaryName: string, sources: readonly string[]): void {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const binary = join(directory, binaryName);
  try {
    execFileSync('xcrun', [
      'swiftc',
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

it.runIf(process.platform === 'darwin')('executes the native budget boundary checks', () => {
  runSwiftChecks('apple-model-budget-', 'budget-tests', [
    './ios/AppleModelBudget.swift',
    './tests/AppleModelBudgetTests.swift',
  ]);
});

it.runIf(process.platform === 'darwin')('executes bounded native recovery checks', () => {
  runSwiftChecks('apple-model-retry-', 'retry-tests', [
    './ios/AppleModelRetry.swift',
    './tests/AppleModelRetryTests.swift',
  ]);
});
