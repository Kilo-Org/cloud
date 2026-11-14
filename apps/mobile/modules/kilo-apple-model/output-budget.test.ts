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

function normalizeSwift(source: string): string {
  return source.replaceAll(/\s+/g, ' ');
}

const normalizedModuleSource = normalizeSwift(moduleSource);

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
  expect(normalizedModuleSource).toContain('AppleModelBudget.outputCeiling');
  expect(normalizedModuleSource).toContain('options.maximumResponseTokens');
  expect(normalizedModuleSource).toContain('AppleModelBudget.responseLimit');
  expect(normalizedModuleSource).toContain('reason: "context_window_exceeded"');
  expect(normalizedModuleSource).toContain('completion.stop = "maxTokens"');
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
