import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANGELOG,
  INITIAL_MARKER,
  NOTES_PATHS,
  NO_PULL_REQUEST_MARKER,
} from './kilo-extension-release-notes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES = join(HERE, 'kilo-extension-release-notes.mjs');
const CONFIG = join(HERE, '..', 'apps', 'extension', 'wxt.config.ts');
const HEADER = '# Kilo Extension Changelog\n\nNewest first: one section per store build.\n\n';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFile(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** A scratch repository with its own identity, outside any checkout. */
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'kilo-extension-notes-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  for (const [key, value] of [
    ['user.name', 'Kilo Test'],
    ['user.email', 'test@kilo.ai'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ]) {
    git(repo, ['config', key, value]);
  }
  return { root, repo };
}

function commitFiles(repo, files, message) {
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

function run(repo, args) {
  return spawnSync(process.execPath, [NOTES, ...args], { cwd: repo, encoding: 'utf8' });
}

test('the notes paths cover every package the store build bundles', () => {
  const config = readFileSync(CONFIG, 'utf8');
  const bundled = [...config.matchAll(/'packages\/([^/']+)\/src\/\*\*'/g)].map(
    match => `packages/${match[1]}/`
  );
  assert.ok(bundled.length > 0, 'the sources allowlist names at least one package');
  assert.deepEqual(NOTES_PATHS.filter(path => path.startsWith('packages/')).sort(), bundled.sort());
  assert.ok(NOTES_PATHS.includes('apps/extension/'), 'the extension itself is a release path');
});

test('body links the pull requests the store build shipped', () => {
  const { root, repo } = scratchRepo();
  try {
    commitFiles(
      repo,
      {
        'apps/extension/src/main.ts': 'export const version = 1;\n',
        [CHANGELOG]: HEADER,
      },
      'init'
    );
    git(repo, ['tag', 'kilo-extension-release/1.0.0']);

    commitFiles(
      repo,
      { 'apps/extension/src/main.ts': 'export const version = 2;\n' },
      'feat(extension): add side panel button (#12)'
    );
    commitFiles(
      repo,
      { 'packages/cloud-agent-sdk/src/client.ts': 'export const retries = 1;\n' },
      'fix(cloud-agent-sdk): retry a dropped stream (#13)'
    );
    commitFiles(
      repo,
      { 'apps/extension/src/main.ts': 'export const version = 3;\n' },
      'chore: direct push to main'
    );
    commitFiles(
      repo,
      { 'apps/extension/package.json': '{"version":"1.0.1"}\n' },
      'chore(extension): bump version to 1.0.1 (#14)'
    );
    commitFiles(
      repo,
      { [CHANGELOG]: `${HEADER}## 1.0.0 (2026-10-01)\n\n- first\n\n` },
      'docs(extension): land a section (#15)'
    );
    commitFiles(
      repo,
      { 'apps/web/src/page.ts': 'export const page = 1;\n' },
      'feat(web): unrelated change (#16)'
    );

    const result = run(repo, ['body', '--from', 'kilo-extension-release/1.0.0']);
    assert.equal(result.status, 0, result.stderr);
    // The direct commit has no pull request, the bump PR carries no product
    // change, the changelog commit is excluded from the path list, and the
    // unrelated path is outside the extension.
    assert.equal(
      result.stdout,
      '- feat(extension): add side panel button ([#12](https://github.com/Kilo-Org/cloud/pull/12))\n' +
        '- fix(cloud-agent-sdk): retry a dropped stream ([#13](https://github.com/Kilo-Org/cloud/pull/13))\n'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('body without a previous ref is the first-release marker', () => {
  const { root, repo } = scratchRepo();
  try {
    commitFiles(repo, { 'apps/extension/src/main.ts': 'export const version = 1;\n' }, 'init');
    const result = run(repo, ['body']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${INITIAL_MARKER}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('body reports no pull request when only direct commits shipped', () => {
  const { root, repo } = scratchRepo();
  try {
    const base = commitFiles(
      repo,
      { 'apps/extension/src/main.ts': 'export const version = 1;\n' },
      'init'
    );
    git(repo, ['tag', 'kilo-extension-release/1.0.0', base]);
    commitFiles(
      repo,
      { 'apps/extension/src/main.ts': 'export const version = 2;\n' },
      'chore: direct push to main'
    );

    const result = run(repo, ['body', '--from', 'kilo-extension-release/1.0.0']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${NO_PULL_REQUEST_MARKER}\n`);

    // A ref that does not resolve is a usage error, never an empty history.
    const unknown = run(repo, ['body', '--from', 'kilo-extension-release/0.0.0']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /--from ref does not resolve/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write inserts the section above the newest one and is idempotent', () => {
  const { root, repo } = scratchRepo();
  try {
    const older = '## 1.0.1 (2026-11-01)\n\n- second\n\n## 1.0.0 (2026-10-01)\n\n- first\n\n';
    writeFile(repo, CHANGELOG, HEADER + older);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const bodyFile = writeFile(repo, 'notes.md', '- feat(extension): add a button (#12)\n');
    const section = '## 1.0.2 (2026-11-17)\n\n- feat(extension): add a button (#12)\n\n';

    const first = run(repo, [
      'write',
      '--heading',
      '## 1.0.2 (2026-11-17)',
      '--body-file',
      bodyFile,
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(readFileSync(join(repo, CHANGELOG), 'utf8'), HEADER + section + older);

    const rerun = run(repo, [
      'write',
      '--heading',
      '## 1.0.2 (2026-11-17)',
      '--body-file',
      bodyFile,
    ]);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /already present/);
    assert.equal(readFileSync(join(repo, CHANGELOG), 'utf8'), HEADER + section + older);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write gives the first section a blank line after the header', () => {
  const { root, repo } = scratchRepo();
  try {
    writeFile(repo, CHANGELOG, HEADER.trimEnd() + '\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'init']);

    const bodyFile = writeFile(repo, 'notes.md', `${INITIAL_MARKER}\n`);
    const result = run(repo, [
      'write',
      '--heading',
      '## 1.0.2 (2026-11-17)',
      '--body-file',
      bodyFile,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(repo, CHANGELOG), 'utf8'),
      `${HEADER}## 1.0.2 (2026-11-17)\n\n${INITIAL_MARKER}\n\n`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write fails when the changelog is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'kilo-extension-notes-'));
  try {
    const dir = join(root, 'not-a-repository');
    mkdirSync(dir);
    const bodyFile = writeFile(dir, 'notes.md', `${NO_PULL_REQUEST_MARKER}\n`);
    const result = run(dir, [
      'write',
      '--heading',
      '## 1.0.2 (2026-11-17)',
      '--body-file',
      bodyFile,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no changelog at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
