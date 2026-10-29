import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const oxlintBinary = path.join(
  fixtureDirectory,
  '..',
  '..',
  '..',
  '..',
  '..',
  'node_modules',
  '.bin',
  'oxlint'
);

type OxlintOutput = {
  readonly diagnostics: readonly { readonly code: string }[];
};

const runOxlint = () => {
  const { promise, resolve } = Promise.withResolvers<{
    exitCode: number | undefined;
    stdout: string;
  }>();
  execFile(
    oxlintBinary,
    ['--config', 'oxlintrc.json', '--format', 'json', 'nested-alias-substitutions.ts'],
    { cwd: fixtureDirectory },
    (error, stdout) => {
      resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : undefined,
        stdout,
      });
    }
  );
  return promise;
};

test('classifies alias types across substitution layers and reports the control contracts', async () => {
  const { exitCode, stdout } = await runOxlint();
  const report = JSON.parse(stdout) as OxlintOutput;
  assert.deepEqual(report.diagnostics.map(diagnostic => diagnostic.code).sort(), [
    'anti-slop(no-known-value-widening)',
    'anti-slop(no-unsafe-dictionary-type)',
    'anti-slop(no-unsafe-dictionary-type)',
  ]);
  assert.equal(exitCode, 1);
});
