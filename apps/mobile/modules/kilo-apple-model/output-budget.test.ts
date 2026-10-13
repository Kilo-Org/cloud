import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const moduleSource = readFileSync(
  new URL('./ios/KiloAppleModelModule.swift', import.meta.url),
  'utf8'
);

it('uses the counted transcript budget for generation and reported truncation', () => {
  expect(moduleSource).toContain('inputTokens = try await model.tokenCount(for: entries)');
  expect(moduleSource).toContain('"maxOutputTokens": AppleModelBudget.outputCeiling');
  expect(moduleSource).toContain('options.maximumResponseTokens = responseLimit');
  expect(moduleSource).toContain('outputTokens >= responseLimit');
  expect(moduleSource).toContain('throw AppleModelFailure(reason: "context_window_exceeded")');
});

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

it('answers replayed calls before any tool call can be emitted to JavaScript', () => {
  const answer = moduleSource.slice(moduleSource.indexOf('fileprivate func answer('));
  const replay = answer.indexOf('if retry.replaying {');
  const dispatch = answer.indexOf('current.emit(');
  expect(replay).toBeGreaterThan(0);
  expect(dispatch).toBeGreaterThan(replay);
  expect(answer.slice(replay, dispatch)).toContain(
    'retry.result(name: name, arguments: arguments)'
  );
  expect(answer.slice(replay, dispatch)).toContain(
    'throw AppleModelFailure(reason: "tool_replay_unmatched")'
  );
  expect(answer.slice(replay, dispatch)).toContain('return body');
  expect(moduleSource).toContain('Self.entries(request, tools: replayTools)');
  expect(moduleSource).toContain('tools: replayTools, transcript: Transcript(entries: restored)');
});

it.runIf(process.platform === 'darwin')('executes the native mutation replay checks', () => {
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
    expect(execFileSync(binary, { encoding: 'utf8' })).toContain('settings_set mutations=1');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
