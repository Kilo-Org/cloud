import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { CommandExecutor } from './command.js';
import {
  applyDotenvPatches,
  assertNoEnvironmentValuesInTrackedFiles,
  createDotenvPatch,
  discoverTrackedDotenvFiles,
  patchDotenvContent,
  renderDotenvPatchPreview,
  restoreDotenvPatches,
} from './dotenv-files.js';

const fakeGit: CommandExecutor = async () => ({
  status: 0,
  stdout: [
    '.env.local.example',
    '.envrc',
    'apps/web/.env',
    'apps/web/.env.development.local.example',
    'apps/web/.env.test',
    'apps/web/.env.local',
    'apps/mobile/.env',
    '',
  ].join('\0'),
  stderr: '',
});

void test('discovers only tracked root and apps/web dotenv defaults', async () => {
  assert.deepEqual(await discoverTrackedDotenvFiles('/repo', fakeGit), [
    '.env.local.example',
    'apps/web/.env',
    'apps/web/.env.development.local.example',
    'apps/web/.env.test',
  ]);
});

void test('patches one assignment without reformatting surrounding content', () => {
  const before = "# auth\nTOKEN = 'old value'\nUNCHANGED=x\n";
  const result = patchDotenvContent(before, 'TOKEN', 'safe default');
  assert.equal(result.content, "# auth\nTOKEN = 'safe default'\nUNCHANGED=x\n");
  assert.equal(result.existed, true);
});

void test('appends a missing assignment and rejects duplicate keys', () => {
  assert.equal(
    patchDotenvContent('A=1', 'TOKEN', 'invalid-token').content,
    'A=1\nTOKEN=invalid-token\n'
  );
  assert.throws(
    () => patchDotenvContent('TOKEN=one\nTOKEN=two\n', 'TOKEN', 'safe'),
    /more than once/
  );
});

void test('restores exact pre-command content around existing edits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-env-dotenv-test-'));
  try {
    await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
    const file = path.join(root, 'apps', 'web', '.env.test');
    const before = '# user edit\nTOKEN=old\n';
    await writeFile(file, before);
    const patch = await createDotenvPatch(root, 'apps/web/.env.test', 'TOKEN', 'invalid-token');
    await applyDotenvPatches([patch]);
    assert.equal(await readFile(file, 'utf8'), '# user edit\nTOKEN=invalid-token\n');
    await restoreDotenvPatches([patch]);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('ignores assignment-like lines inside unrelated multiline values', () => {
  const content = 'OTHER="begin\nTOKEN=embedded\nend"\nTOKEN=real\n';
  assert.equal(
    patchDotenvContent(content, 'TOKEN', 'safe').content,
    'OTHER="begin\nTOKEN=embedded\nend"\nTOKEN=safe\n'
  );
});

void test('preserves inline comments and replaces complete multiline values', () => {
  assert.equal(
    patchDotenvContent('TOKEN=old-value  # setup\n', 'TOKEN', 'safe').content,
    'TOKEN=safe  # setup\n'
  );
  assert.equal(
    patchDotenvContent('TOKEN="old\nmultiline" # setup\nNEXT=x\n', 'TOKEN', 'safe default').content,
    'TOKEN="safe default" # setup\nNEXT=x\n'
  );
});

void test('rejects raw or escaped real values in patched and skipped tracked files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'web-env-secret-guard-test-'));
  try {
    await mkdir(path.join(root, 'apps', 'web'), { recursive: true });
    await writeFile(path.join(root, 'apps', 'web', '.env.test'), 'OTHER="line-one\\nline-two"\n');
    await assert.rejects(
      assertNoEnvironmentValuesInTrackedFiles(root, ['apps/web/.env.test'], [], {
        development: 'development-real-value',
        staging: 'line-one\nline-two',
        production: 'production-real-value',
      }),
      /real environment value/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('renders only invocation-owned dotenv lines and redacts old values', () => {
  const preview = renderDotenvPatchPreview(
    [
      {
        relativePath: 'apps/web/.env.test',
        absolutePath: '/repo/apps/web/.env.test',
        before: 'UNRELATED=secret\nTOKEN=old-secret\n',
        after: 'UNRELATED=secret\nTOKEN=invalid-token\n',
        existed: true,
        defaultValue: 'invalid-token',
      },
    ],
    'TOKEN'
  );
  assert.match(preview, /TOKEN=<redacted existing tracked value>/);
  assert.match(preview, /TOKEN=invalid-token/);
  assert.equal(preview.includes('UNRELATED'), false);
  assert.equal(preview.includes('old-secret'), false);
});
