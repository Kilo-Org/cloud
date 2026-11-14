import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

import {
  CHANGELOG,
  NO_PULL_REQUEST_MARKER,
  bodyLines,
  rebuildChangelog,
} from './kilo-mcp-release-notes.mjs';
import { bundledPackages, packageRootOf } from './kilo-mcp-sbom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES = join(HERE, 'kilo-mcp-release-notes.mjs');
const WORKFLOW = join(HERE, '..', '.github', 'workflows', 'kilo-mcp-release.yml');
const HEADER = '# Kilo MCP Changelog\n\nNewest first.\n\n';
// Any pipe in the check step must carry more than a pipe buffer for the
// early-closing `head` regression to be reachable: 6000 tags of ~35 bytes.
const TAG_COUNT = 6000;
const PIPE_BUFFER = 64 * 1024;

function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

function writeFile(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** A bare `origin` with a main branch that holds the changelog, and a clone of it. */
function remoteWithChangelog(content) {
  const root = mkdtempSync(join(tmpdir(), 'kilo-mcp-land-'));
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['clone', '-q', origin, clone]);
  for (const [key, value] of [
    ['user.name', 'Kilo Test'],
    ['user.email', 'test@kilo.ai'],
    ['commit.gpgsign', 'false'],
  ]) {
    git(clone, ['config', key, value]);
  }
  writeFile(clone, CHANGELOG, content);
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'init']);
  git(clone, ['push', '-q', 'origin', 'HEAD:main']);
  return { root, clone };
}

function land(clone, heading, body) {
  const bodyFile = writeFile(clone, '../body.md', `${body}\n`);
  return spawnSync(
    process.execPath,
    [NOTES, 'land', '--heading', heading, '--body-file', bodyFile],
    { cwd: clone, encoding: 'utf8' }
  );
}

function branchChangelog(clone) {
  git(clone, ['fetch', '-q', 'origin', 'kilo-mcp-changelog']);
  return git(clone, ['show', `FETCH_HEAD:${CHANGELOG}`]);
}

/** The `run:` block of the release job's check step. */
function checkStepScript() {
  const workflow = load(readFileSync(WORKFLOW, 'utf8'));
  const step = workflow.jobs.release.steps.find(candidate => candidate.id === 'check');
  assert.equal(typeof step?.run, 'string');
  return step.run;
}

/** A scratch repository with its own identity, outside any checkout. */
function releaseRepo() {
  const root = mkdtempSync(join(tmpdir(), 'kilo-mcp-check-'));
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

function commitFiles(repo, files, message, env) {
  for (const [rel, content] of Object.entries(files)) writeFile(repo, rel, content);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message], env);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/** `count` release tags on one commit, created by a single git process. */
function tagCommit(repo, commit, prefix, count) {
  const refs = Array.from({ length: count }, (_, index) => {
    return `create refs/tags/${prefix}${String(index).padStart(7, '0')} ${commit}\n`;
  }).join('');
  execFileSync('git', ['update-ref', '--stdin'], {
    cwd: repo,
    input: refs,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Run the check step in `cwd` as the runner does: one bash script with the
 * step's environment, whose appended step outputs come back parsed.
 */
function runCheck(cwd) {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-mcp-run-'));
  const script = join(dir, 'step.sh');
  const output = join(dir, 'output');
  writeFileSync(script, checkStepScript());
  writeFileSync(output, '');
  try {
    const result = spawnSync('bash', [script], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: output },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        })
    );
    return { status: result.status, stderr: result.stderr, outputs };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bodyLines links each pull request and drops direct commits', () => {
  assert.deepEqual(bodyLines(['feat(kilo-mcp): add x (#12)', 'chore: direct push']), [
    '- feat(kilo-mcp): add x ([#12](https://github.com/Kilo-Org/cloud/pull/12))',
  ]);
  assert.deepEqual(bodyLines(['chore: direct push']), [NO_PULL_REQUEST_MARKER]);
});

test('rebuildChangelog keeps unmerged branch sections under the new one', () => {
  const merged = '## 2026-10-01 (aaaaaaa)\n\n- merged\n\n';
  const pending = '## 2026-10-02 (bbbbbbb)\n\n- pending\n\n';
  const base = HEADER + merged;
  const branch = HEADER + pending + merged;
  const section = '## 2026-10-03 (ccccccc)\n\n- new\n\n';
  assert.equal(
    rebuildChangelog(base, branch, '## 2026-10-03 (ccccccc)', section),
    HEADER + section + pending + merged
  );
});

test('rebuildChangelog returns null when the base already holds every section', () => {
  const section = '## 2026-10-03 (ccccccc)\n\n- new\n\n';
  const base = HEADER + section;
  assert.equal(rebuildChangelog(base, base, '## 2026-10-03 (ccccccc)', section), null);
});

test('land creates the branch, then carries its sections after the PR merged', () => {
  // The committed file ends with one newline; the first section still gets a blank line.
  const { root, clone } = remoteWithChangelog(HEADER.replace(/\n+$/, '\n'));
  try {
    const first = land(clone, '## 2026-10-01 (aaaaaaa)', '- one');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(branchChangelog(clone), `${HEADER}## 2026-10-01 (aaaaaaa)\n\n- one\n\n`);

    // A second release before the merge stacks above the first.
    const second = land(clone, '## 2026-10-02 (bbbbbbb)', '- two');
    assert.equal(second.status, 0, second.stderr);
    const both = branchChangelog(clone);
    assert.equal(
      both,
      `${HEADER}## 2026-10-02 (bbbbbbb)\n\n- two\n\n## 2026-10-01 (aaaaaaa)\n\n- one\n\n`
    );

    // A squash merge of the PR deletes the branch; main moves on.
    git(clone, ['fetch', '-q', 'origin', 'main']);
    git(clone, ['checkout', '-q', 'FETCH_HEAD']);
    writeFile(clone, CHANGELOG, both);
    writeFile(clone, 'other.txt', 'unrelated\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '-q', '-m', 'squash (#1)']);
    git(clone, ['push', '-q', 'origin', 'HEAD:main']);
    git(clone, ['push', '-q', 'origin', '--delete', 'kilo-mcp-changelog']);

    const third = land(clone, '## 2026-10-03 (ccccccc)', '- three');
    assert.equal(third.status, 0, third.stderr);
    assert.equal(
      branchChangelog(clone),
      `${HEADER}## 2026-10-03 (ccccccc)\n\n- three\n\n${both.slice(HEADER.length)}`
    );
    // A rerun of a landed release pushes nothing and keeps one copy of its section.
    const rerun = land(clone, '## 2026-10-03 (ccccccc)', '- three');
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /landed .* \(already present\)/);
    assert.equal(branchChangelog(clone).split('## 2026-10-03').length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packageRootOf resolves plain and scoped packages under the last node_modules', () => {
  assert.equal(
    packageRootOf('/r/node_modules/.pnpm/zod@4.4.3/node_modules/zod/v4/core/index.js'),
    '/r/node_modules/.pnpm/zod@4.4.3/node_modules/zod'
  );
  assert.equal(
    packageRootOf('/r/node_modules/@cfworker/json-schema/dist/index.js'),
    '/r/node_modules/@cfworker/json-schema'
  );
  assert.equal(packageRootOf('/r/services/kilo-mcp/src/index.ts'), null);
});

test('bundledPackages lists only packages the bundle carries bytes of', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kilo-mcp-sbom-'));
  try {
    writeFile(dir, 'node_modules/kept/package.json', '{"name":"kept","version":"1.0.0"}');
    writeFile(dir, 'node_modules/kept/a.js', '');
    writeFile(dir, 'node_modules/kept/b.js', '');
    writeFile(dir, 'node_modules/shaken/package.json', '{"name":"shaken","version":"2.0.0"}');
    writeFile(dir, 'node_modules/shaken/index.js', '');
    writeFile(dir, 'src/index.ts', '');
    const metafile = {
      outputs: {
        'out/index.js': {
          inputs: {
            'node_modules/kept/a.js': { bytesInOutput: 10 },
            'node_modules/kept/b.js': { bytesInOutput: 5 },
            'node_modules/shaken/index.js': { bytesInOutput: 0 },
            'node_modules/virtual/_virtual_polyfill': { bytesInOutput: 7 },
            'src/index.ts': { bytesInOutput: 99 },
          },
        },
      },
    };
    const lockfile = {
      packages: { 'kept@1.0.0': { resolution: { integrity: 'sha512-AAAA' } } },
    };
    const components = bundledPackages({
      metafile,
      workerDir: dir,
      bundlePath: join(dir, 'out/index.js'),
      lockfile,
    });
    assert.deepEqual(components, [
      {
        ecosystem: 'npm',
        name: 'kept',
        version: '1.0.0',
        purl: 'pkg:npm/kept@1.0.0',
        hashes: [{ alg: 'SHA-512', content: '000000' }],
        extraProperties: [{ name: 'kilo:sbom:bundled-bytes', value: '15' }],
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The check step pipes two git tag lists through a first-line selector. A
// selector that closes the pipe after one line kills git with SIGPIPE once the
// list outgrows the pipe buffer, and `pipefail` then fails the release on a tag
// history that merely got long enough. These tests run the step's own script
// against real tag histories larger than a pipe buffer, so the failure is
// deterministic instead of waiting for enough releases to accumulate.

test('the first release starts from an empty tag history', () => {
  const { root, repo } = releaseRepo();
  try {
    commitFiles(repo, { 'services/kilo-mcp/src/index.ts': 'export const version = 1;\n' }, 'init');
    const result = runCheck(repo);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.previous, '');
    assert.equal(result.outputs.resume, 'false');
    assert.equal(result.outputs.candidate, 'true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rerun resumes from many release tags at the deployed commit', () => {
  const { root, repo } = releaseRepo();
  try {
    commitFiles(repo, { 'services/kilo-mcp/src/index.ts': 'export const version = 1;\n' }, 'init');
    const head = commitFiles(
      repo,
      { 'services/kilo-mcp/src/index.ts': 'export const version = 2;\n' },
      'deploy'
    );
    tagCommit(repo, head, 'kilo-mcp-release/2020-01-01-', TAG_COUNT);

    const tags = git(repo, ['tag', '--points-at', 'HEAD', '--list', 'kilo-mcp-release/*']);
    assert.ok(tags.length > PIPE_BUFFER, `the pipe carries ${tags.length} bytes of tags`);
    const existing = tags.split('\n')[0];

    const result = runCheck(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.tag, existing);
    assert.equal(result.outputs.resume, 'true');
    assert.equal(result.outputs.previous, '');
    assert.equal(result.outputs.candidate, 'true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the newest of many historical tags is the previous release', () => {
  const { root, repo } = releaseRepo();
  try {
    const base = commitFiles(
      repo,
      { 'services/kilo-mcp/src/index.ts': 'export const version = 1;\n' },
      'base',
      { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' }
    );
    tagCommit(repo, base, 'kilo-mcp-release/2020-01-01-', TAG_COUNT);
    const newest = 'kilo-mcp-release/2020-01-02-newest';
    git(repo, ['tag', '-a', newest, '-m', newest, base], {
      GIT_COMMITTER_DATE: '2020-01-02T00:00:00Z',
    });
    commitFiles(
      repo,
      { 'services/kilo-mcp/src/index.ts': 'export const version = 2;\n' },
      'change'
    );

    const listed = git(repo, [
      'tag',
      '--list',
      'kilo-mcp-release/*',
      '--sort=-creatordate',
      '--no-contains',
      'HEAD',
    ]);
    assert.ok(listed.length > PIPE_BUFFER, `the pipe carries ${listed.length} bytes of tags`);
    assert.equal(listed.split('\n')[0], newest);

    const result = runCheck(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.previous, newest);
    assert.equal(result.outputs.resume, 'false');
    assert.equal(result.outputs.candidate, 'true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the change gate ignores a changelog-only commit and releases a bundle input', () => {
  const { root, repo } = releaseRepo();
  try {
    const base = commitFiles(
      repo,
      {
        'services/kilo-mcp/src/index.ts': 'export const version = 1;\n',
        'services/kilo-mcp/CHANGELOG.md': '# Kilo MCP\n',
      },
      'base'
    );
    const previous = 'kilo-mcp-release/2026-01-01-aaaaaaa';
    git(repo, ['tag', previous, base]);

    commitFiles(
      repo,
      { 'services/kilo-mcp/CHANGELOG.md': '# Kilo MCP\n\n## 2026-01-01 (aaaaaaa)\n' },
      'docs(kilo-mcp): land a section (#1)'
    );
    const unchanged = runCheck(repo);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.outputs.previous, previous);
    assert.equal(unchanged.outputs.resume, 'false');
    assert.equal(unchanged.outputs.candidate, 'false');

    commitFiles(repo, { 'patches/example.patch': 'diff --git a/x b/x\n' }, 'build: patch a dep');
    const changed = runCheck(repo);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(changed.outputs.previous, previous);
    assert.equal(changed.outputs.candidate, 'true');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a git failure fails the check instead of reading as an empty history', () => {
  const root = mkdtempSync(join(tmpdir(), 'kilo-mcp-check-'));
  const dir = join(root, 'not-a-repository');
  mkdirSync(dir);
  try {
    const result = runCheck(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a git repository/);
    assert.deepEqual(result.outputs, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
