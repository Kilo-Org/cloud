import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { expect, it } from 'vitest';

it.runIf(process.platform === 'darwin')('executes the native budget boundary checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apple-model-budget-'));
  const binary = join(directory, 'budget-tests');
  try {
    execFileSync('xcrun', [
      'swiftc',
      '-parse-as-library',
      fileURLToPath(new URL('./ios/AppleModelBudget.swift', import.meta.url)),
      fileURLToPath(new URL('./tests/AppleModelBudgetTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'darwin')('executes bounded native recovery checks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apple-model-retry-'));
  const binary = join(directory, 'retry-tests');
  try {
    execFileSync('xcrun', [
      'swiftc',
      '-parse-as-library',
      fileURLToPath(new URL('./ios/AppleModelRetry.swift', import.meta.url)),
      fileURLToPath(new URL('./tests/AppleModelRetryTests.swift', import.meta.url)),
      '-o',
      binary,
    ]);
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('all checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
