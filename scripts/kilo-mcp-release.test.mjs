import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHANGELOG,
  NO_PULL_REQUEST_MARKER,
  bodyLines,
  rebuildChangelog,
} from './kilo-mcp-release-notes.mjs';
import { bundledPackages, packageRootOf } from './kilo-mcp-sbom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTES = join(HERE, 'kilo-mcp-release-notes.mjs');
const HEADER = '# Kilo MCP Changelog\n\nNewest first.\n\n';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
