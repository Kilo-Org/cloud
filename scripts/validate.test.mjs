import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  MissingStepError,
  STEP_ORDER,
  describeSteps,
  isMainModule,
  resolveSteps,
} from './validate.mjs';

const scriptPath = fileURLToPath(new URL('./validate.mjs', import.meta.url));
// The exact URL the guard compares against, so the tests exercise the real value
// rather than one rebuilt from the same helper under test.
const scriptUrl = new URL('./validate.mjs', import.meta.url).href;
const allSteps = {
  typecheck: 'node typecheck.mjs',
  lint: 'node lint.mjs',
  'format:changed:check': 'node format-changed-check.mjs',
  test: 'node test.mjs',
  'dependency-cycle-check': 'node dependency-cycle-check.mjs',
};

test('a manifest with every step resolves the whole chain in order', () => {
  const steps = resolveSteps({ scripts: { ...allSteps } }, '/fixture');
  assert.deepEqual(
    steps,
    STEP_ORDER.map(name => ({ name, run: true }))
  );
  assert.deepEqual(
    steps.map(step => step.name),
    ['typecheck', 'lint', 'format:changed:check', 'test', 'dependency-cycle-check']
  );
});

test('a manifest without format:changed:check resolves the four required steps', () => {
  const { 'format:changed:check': _skipped, ...required } = allSteps;
  const steps = resolveSteps({ scripts: required }, '/fixture');
  assert.deepEqual(steps, [
    { name: 'typecheck', run: true },
    { name: 'lint', run: true },
    { name: 'format:changed:check', run: false },
    { name: 'test', run: true },
    { name: 'dependency-cycle-check', run: true },
  ]);
  assert.equal(
    describeSteps(steps)
      .split('\n')
      .filter(line => line.startsWith('run ')).length,
    4
  );
});

test('a manifest missing a required step refuses the run and names it', () => {
  const { lint: _omitted, ...rest } = allSteps;
  assert.throws(
    () => resolveSteps({ scripts: rest }, '/fixture'),
    error => {
      assert.ok(error instanceof MissingStepError);
      assert.deepEqual(error.steps, ['lint']);
      assert.match(error.message, /required script: lint/);
      assert.match(error.message, /\/fixture/);
      return true;
    }
  );

  const dir = mkdtempSync(join(tmpdir(), 'validate-missing-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node x.mjs' } }));
    const result = spawnSync(process.execPath, [scriptPath, '--list'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /typecheck/);
    assert.match(result.stderr, /dependency-cycle-check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stub executable keeps the end-to-end runs off the real pnpm store: it
// forwards `run <step>` to the manifest's own command for that step.
function writePnpmStub(directory) {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'pnpm');
  writeFileSync(
    file,
    [
      '#!/usr/bin/env node',
      "const { readFileSync } = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      'const args = process.argv.slice(2);',
      "if (args[0] !== 'run' || !args[1]) {",
      "  console.error('stub pnpm: unexpected arguments ' + args.join(' '));",
      '  process.exit(64);',
      '}',
      'const manifest = JSON.parse(readFileSync(',
      "  require('node:path').join(process.cwd(), 'package.json'),",
      "  'utf8'",
      '));',
      'const command = manifest.scripts[args[1]];',
      "if (!command) { console.error('stub pnpm: no script ' + args[1]); process.exit(65); }",
      "const result = spawnSync('sh', ['-c', command], { stdio: 'inherit' });",
      'process.exit(result.status ?? 1);',
      '',
    ].join('\n')
  );
  chmodSync(file, 0o755);
}

// The fixture manifest's steps append their name to `steps.log`, in the order
// the chain selects them; a step the fixture makes fail exits with 9.
function writeFixture(directory, failingStep) {
  writeFileSync(
    join(directory, 'append.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(new URL('./steps.log', import.meta.url), process.argv[2] + '\\n');",
      '',
    ].join('\n')
  );
  writeFileSync(join(directory, 'fail.mjs'), 'process.exit(9);\n');
  const scripts = {};
  for (const name of STEP_ORDER) {
    scripts[name] = name === failingStep ? 'node fail.mjs' : `node append.mjs ${name}`;
  }
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts }));
  return scripts;
}

function runIn(directory, args = []) {
  const bin = join(directory, 'bin');
  writePnpmStub(bin);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });
  const logFile = join(directory, 'steps.log');
  let log = [];
  try {
    log = readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
  } catch {
    log = [];
  }
  return { ...result, log };
}

test('the whole chain runs every step in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-chain-'));
  try {
    writeFixture(dir);
    const result = runIn(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.log, [
      'typecheck',
      'lint',
      'format:changed:check',
      'test',
      'dependency-cycle-check',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the chain stops at the first failing step and reports its exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-fail-'));
  try {
    writeFixture(dir, 'format:changed:check');
    const result = runIn(dir);
    assert.equal(result.status, 9);
    assert.deepEqual(result.log, ['typecheck', 'lint']);
    assert.match(result.stderr, /format:changed:check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--list prints each resolved step and runs nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'validate-list-'));
  try {
    writeFixture(dir, 'lint');
    const result = runIn(dir, ['--list']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.log, []);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'run typecheck',
      'run lint',
      'run format:changed:check',
      'run test',
      'run dependency-cycle-check',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard fires when the invoked path is this module', () => {
  assert.equal(isMainModule(scriptUrl, scriptPath), true);
});

test('the guard stays quiet for a different invoked path', () => {
  assert.equal(isMainModule(scriptUrl, '/fixture/other.mjs'), false);
});

test('the guard stays quiet when the module was imported, not run', () => {
  // An imported module has no entry path: `process.argv[1]` is the importer's.
  assert.equal(isMainModule(scriptUrl, undefined), false);
});

test('the guard compares through file-URL encoding, not raw strings', () => {
  // Inserting a space into the real path is enough: the module URL then carries
  // `%20`, so raw string equality would miss the match.
  const spacedPath = scriptPath.replace(/([^/]+)$/, 'with space $1');
  assert.doesNotMatch(scriptUrl, /with space/);
  assert.match(pathToFileURL(spacedPath).href, /with%20space/);
  assert.equal(isMainModule(pathToFileURL(spacedPath).href, spacedPath), true);
});
