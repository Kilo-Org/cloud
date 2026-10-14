import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

const workflow = load(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
);
const extension = JSON.parse(
  readFileSync(new URL('../apps/extension/package.json', import.meta.url), 'utf8')
);
const rootScript = fileURLToPath(new URL('./typecheck-all.sh', import.meta.url));

for (const [name, command] of [
  ['typecheck', 'scripts/typecheck-all.sh'],
  ['lint', 'pnpm --filter @kilocode/harness-sdk run build'],
  ['harness-sdk', 'pnpm --filter @kilocode/harness-sdk check:ci'],
  ['workspace-tests', 'pnpm --filter @kilocode/harness-sdk run build'],
]) {
  test(`${name} restores the compiler plugin cache after install and before use`, () => {
    const steps = workflow.jobs[name].steps;
    const cacheIndex = steps.findIndex(step => step.name === 'Cache compiler plugins');
    const installIndex = steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
    const buildIndex = steps.findIndex(step => step.run === command);
    assert.ok(installIndex >= 0 && cacheIndex > installIndex && buildIndex > cacheIndex);
    const cache = steps[cacheIndex];
    assert.equal(cache.uses, 'actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7');
    assert.equal(cache.with.path, 'node_modules/.cache/ttsc/plugins');
    assert.equal(
      cache.with.key,
      "${{ runner.os }}-${{ runner.arch }}-ttsc-plugins-${{ hashFiles('pnpm-lock.yaml') }}"
    );
    assert.equal(
      cache.with['restore-keys'].trim(),
      '${{ runner.os }}-${{ runner.arch }}-ttsc-plugins-'
    );
    assert.equal(cache.if, steps[buildIndex].if);
  });
}

function runTypecheck(
  t,
  { root = false, changes = '', buildExit = 0, checkExit = 0, built = '' } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'apps/extension'), { recursive: true });
  writeFileSync(join(dir, 'apps/extension/package.json'), JSON.stringify(extension));
  const cli = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const name = basename(process.argv[1]);
if (name === 'git') {
  if (args[0] === 'merge-base') console.log('base');
  else if (args.includes('packages/trpc/src/**') && process.env.CHANGES === 'trpc') console.log('packages/trpc/src/index.ts');
  else if (args.includes('pnpm-workspace.yaml') && process.env.CHANGES === 'workspace') console.log('pnpm-workspace.yaml');
  else if (args.includes('*.ts')) console.log('apps/extension/package.json');
} else if (name === 'pnpm' && args[0] === '-r') {
  const result = spawnSync('sh', ['-c', process.env.EXTENSION_TYPECHECK], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else {
  appendFileSync(process.env.COMMAND_LOG, name + ' ' + args.join(' ') + '\\n');
  if (name === 'pnpm' && args.includes('@kilocode/trpc')) process.exit(Number(process.env.BUILD_EXIT));
  if (name === 'tsc') process.exit(Number(process.env.CHECK_EXIT));
}
`;
  for (const name of ['pnpm', 'tsgo', 'tsc', 'git']) {
    writeFileSync(join(bin, name), cli, { mode: 0o755 });
  }
  const log = join(dir, 'commands.log');
  writeFileSync(log, '');
  const result = spawnSync(
    root ? 'bash' : 'sh',
    root
      ? [rootScript, ...(changes ? ['--changes-only'] : [])]
      : ['-c', extension.scripts.typecheck],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        KILO_TYPECHECK_TRPC_BUILT: built,
        EXTENSION_TYPECHECK: extension.scripts.typecheck,
        CHANGES: changes,
        BUILD_EXIT: String(buildExit),
        CHECK_EXIT: String(checkExit),
        COMMAND_LOG: log,
      },
    }
  );
  return { status: result.status, commands: readFileSync(log, 'utf8').trim().split('\n') };
}

test('standalone extension checks build tRPC before compiling', t => {
  const result = runTypecheck(t);
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, ['pnpm --filter @kilocode/trpc build', 'tsc --noEmit']);
});

test('extension checks reuse tRPC built by the root script', t => {
  const result = runTypecheck(t, { built: '1' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, ['tsc --noEmit']);
});

test('a failed standalone tRPC build prevents extension compilation', t => {
  const result = runTypecheck(t, { buildExit: 7 });
  assert.equal(result.status, 7);
  assert.deepEqual(result.commands, ['pnpm --filter @kilocode/trpc build']);
});

test('extension compiler errors still fail when tRPC is already built', t => {
  assert.equal(runTypecheck(t, { built: '1', checkExit: 9 }).status, 9);
});

for (const changes of ['', 'trpc', 'extension', 'workspace']) {
  test(`root ${changes || 'full'} typecheck builds tRPC once and checks the extension`, t => {
    const result = runTypecheck(t, { root: true, changes });
    assert.equal(result.status, 0);
    assert.equal(result.commands.filter(command => command.includes('@kilocode/trpc')).length, 1);
    assert.equal(result.commands.at(-1), 'tsc --noEmit');
  });
}

test('a failed root tRPC build stops the typecheck', t => {
  const result = runTypecheck(t, { root: true, buildExit: 7 });
  assert.equal(result.status, 7);
  assert.deepEqual(result.commands, ['pnpm --filter @kilocode/trpc run build']);
});
