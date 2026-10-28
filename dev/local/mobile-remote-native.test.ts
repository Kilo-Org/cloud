import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  artifactName,
  assertSimulatorRuntimeSupports,
  pickDispatchedRun,
} from './mobile-remote-native';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('ignores runs that already existed before the dispatch', () => {
  const before = new Set([10, 9]);
  const runs = [
    { databaseId: 10, headSha: HEAD },
    { databaseId: 9, headSha: HEAD },
  ];
  assert.equal(pickDispatchedRun(runs, before, HEAD), undefined);
});

test('takes the newest new run on this commit', () => {
  const before = new Set([9]);
  const runs = [
    { databaseId: 12, headSha: OTHER },
    { databaseId: 11, headSha: HEAD },
    { databaseId: 10, headSha: HEAD },
    { databaseId: 9, headSha: HEAD },
  ];
  assert.equal(pickDispatchedRun(runs, before, HEAD), 11);
});

test('artifact names stay hash-keyed per platform', () => {
  assert.equal(artifactName('ios', 'deadbeef'), 'mobile-native-ios-deadbeef');
  assert.equal(artifactName('android', 'deadbeef'), 'mobile-native-android-deadbeef');
});

test('accepts an artifact on a simulator runtime at least as new as its SDK', () => {
  assertSimulatorRuntimeSupports(
    { xcodeBuildVersion: '17F113', simulatorSdkVersion: '26.5' },
    '26.5'
  );
  assertSimulatorRuntimeSupports(
    { xcodeBuildVersion: '17F113', simulatorSdkVersion: '26.5' },
    '27.1'
  );
  assertSimulatorRuntimeSupports({ simulatorSdkVersion: '26' }, '26.0.1');
});

test('rejects an artifact whose SDK is newer than the simulator runtime', () => {
  assert.throws(
    () => assertSimulatorRuntimeSupports({ simulatorSdkVersion: '27.1' }, '26.5'),
    /cannot run on simulator runtime 26.5/
  );
  assert.throws(
    () => assertSimulatorRuntimeSupports({ simulatorSdkVersion: '26.10' }, '26.9'),
    /cannot run/
  );
});

test('rejects an artifact with no readable simulator SDK', () => {
  for (const toolchain of [
    null,
    {},
    { simulatorSdkVersion: 26.5 },
    { simulatorSdkVersion: 'beta' },
  ]) {
    assert.throws(() => assertSimulatorRuntimeSupports(toolchain, '27.1'), /cannot run/);
  }
});

const repositoryId = 101;
const workflowId = 201;
const workflowPath = '.github/workflows/mobile-native-build.yml';
const nativeName = artifactName('android', 'provenance');

function trustedRun(id = 301) {
  return {
    id,
    workflow_id: workflowId,
    path: workflowPath,
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    head_sha: HEAD,
    head_branch: 'main',
    repository: { id: repositoryId },
    head_repository: { id: repositoryId },
  };
}

function nativeArtifact(id = 401, runId = 301) {
  return {
    id,
    name: nativeName,
    expired: false,
    created_at: '2026-10-27T00:00:00Z',
    expires_at: '2027-01-25T00:00:00Z',
    workflow_run: {
      id: runId,
      repository_id: repositoryId,
      head_repository_id: repositoryId,
      head_sha: HEAD,
    },
  };
}

function withOfflineArtifacts(
  artifacts: unknown[],
  runs: Record<string, unknown>,
  use: (invoke: (expression: string) => string, log: () => string, dir: string) => void,
  metadata: {
    repository?: unknown;
    workflow?: unknown;
  } = {}
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-provenance-'));
  const logPath = path.join(dir, 'commands.jsonl');
  const unexpectedPath = path.join(dir, 'unexpected.jsonl');
  const fixture = {
    repository: metadata.repository ?? { id: repositoryId, default_branch: 'main' },
    workflow: metadata.workflow ?? { id: workflowId, path: workflowPath, state: 'active' },
    artifacts,
    runs,
  };
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(unexpectedPath, '');
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const fixture = ${JSON.stringify(fixture)};
const prefix = 'repos/{owner}/{repo}';
let result;
if (args.length === 2 && args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint === prefix) result = fixture.repository;
  else if (endpoint === prefix + '/actions/workflows/mobile-native-build.yml') result = fixture.workflow;
  else if (endpoint === prefix + '/actions/artifacts?name=${nativeName}&per_page=100') result = {artifacts: fixture.artifacts};
  else if (endpoint.startsWith(prefix + '/actions/runs/')) {
    const id = endpoint.slice((prefix + '/actions/runs/').length);
    result = fixture.runs[id];
  }
}
if (result === undefined) {
  fs.appendFileSync(${JSON.stringify(unexpectedPath)}, JSON.stringify(args) + '\\n');
  process.stderr.write('unexpected offline gh command: ' + JSON.stringify(args));
  process.exit(91);
}
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])) {
  process.stdout.write(${JSON.stringify(HEAD)} + '\\n');
} else if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD'])) {
  process.stdout.write('HEAD\\n');
} else {
  fs.appendFileSync(${JSON.stringify(unexpectedPath)}, JSON.stringify(args) + '\\n');
  process.exit(92);
}
`,
    { mode: 0o755 }
  );
  try {
    const moduleUrl = new URL('./mobile-remote-native.ts', import.meta.url).href;
    const invoke = (expression: string) =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          `import * as native from ${JSON.stringify(moduleUrl)}; Date.now = () => Date.parse('2026-10-28T00:00:00Z'); console.log(JSON.stringify(${expression}));`,
        ],
        {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, KILO_REMOTE_NATIVE: '' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      ).trim();
    use(invoke, () => fs.readFileSync(logPath, 'utf8'), dir);
    assert.equal(fs.readFileSync(unexpectedPath, 'utf8'), '', 'all commands must stay offline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('artifact lookup skips a newer fork artifact and retains the trusted main push', () => {
  const fork = nativeArtifact(402, 302);
  fork.created_at = '2026-10-28T00:00:00Z';
  fork.workflow_run.head_repository_id = 999;
  withOfflineArtifacts(
    [fork, nativeArtifact()],
    { 301: trustedRun(), 302: trustedRun(302) },
    invoke => {
      assert.deepEqual(
        JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`)),
        [
          {
            id: 401,
            name: nativeName,
            created_at: '2026-10-27T00:00:00Z',
            expires_at: '2027-01-25T00:00:00Z',
          },
        ]
      );
    }
  );
});

test('artifact lookup accepts a manual build on a same-repository feature branch', () => {
  const run = { ...trustedRun(), event: 'workflow_dispatch', head_branch: 'feature/native' };
  withOfflineArtifacts([nativeArtifact()], { 301: run }, invoke => {
    assert.equal(
      JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`))[0]?.id,
      401
    );
  });
});

test('artifact lookup rejects a manual build from another commit even when its source SHA matches the run', () => {
  const artifact = nativeArtifact();
  artifact.workflow_run.head_sha = OTHER;
  const run = {
    ...trustedRun(),
    event: 'workflow_dispatch',
    head_branch: 'feature/native',
    head_sha: OTHER,
  };
  withOfflineArtifacts([artifact], { 301: run }, invoke => {
    assert.deepEqual(
      JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`)),
      []
    );
  });
});

test('artifact lookup reuses a trusted main-push build across consumer commits', () => {
  const artifact = nativeArtifact();
  artifact.workflow_run.head_sha = OTHER;
  withOfflineArtifacts([artifact], { 301: { ...trustedRun(), head_sha: OTHER } }, invoke => {
    assert.equal(
      JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`))[0]?.id,
      401
    );
  });
});

test('artifact lookup rejects untrusted or incomplete run provenance', () => {
  const invalidRuns: Record<string, unknown>[] = [
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { event: 'schedule' },
    { workflow_id: 999 },
    { path: '.github/workflows/other.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_branch: 'feature/native' },
    { head_sha: OTHER },
    { repository: { id: 999 } },
    { head_repository: { id: 999 } },
    { id: 999 },
    ...Object.keys(trustedRun()).map(key => ({ [key]: null })),
  ];
  for (const invalid of invalidRuns) {
    withOfflineArtifacts([nativeArtifact()], { 301: { ...trustedRun(), ...invalid } }, invoke => {
      assert.deepEqual(
        JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`)),
        [],
        JSON.stringify(invalid)
      );
    });
  }
});

test('artifact lookup fails closed on artifact and canonical metadata mismatches', () => {
  const invalidArtifacts = [
    { name: `${nativeName}-other` },
    { expired: true },
    { workflow_run: null },
    { workflow_run: { ...nativeArtifact().workflow_run, repository_id: 999 } },
    { workflow_run: { ...nativeArtifact().workflow_run, head_sha: null } },
    { created_at: 'invalid' },
    { expires_at: null },
  ];
  for (const invalid of invalidArtifacts) {
    withOfflineArtifacts([{ ...nativeArtifact(), ...invalid }], { 301: trustedRun() }, invoke => {
      assert.deepEqual(
        JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`)),
        [],
        JSON.stringify(invalid)
      );
    });
  }
  for (const metadata of [
    { repository: {} },
    { repository: { id: repositoryId } },
    { workflow: {} },
    { workflow: { id: workflowId, path: '.github/workflows/other.yml', state: 'active' } },
    { workflow: { id: workflowId, path: workflowPath, state: 'disabled_manually' } },
  ]) {
    withOfflineArtifacts(
      [nativeArtifact()],
      { 301: trustedRun() },
      invoke => {
        assert.throws(
          () => invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`),
          /Native artifact source could not be verified/
        );
      },
      metadata
    );
  }
});

test('the shipped host downloader refuses a pull-request artifact without downloading its ZIP', () => {
  withOfflineArtifacts(
    [nativeArtifact()],
    { 301: { ...trustedRun(), event: 'pull_request' } },
    (invoke, log, dir) => {
      assert.equal(
        invoke(
          `native.fetchAndroidApk({nativeHash: 'provenance', destDir: ${JSON.stringify(dir)}})`
        ),
        'undefined'
      );
      assert.doesNotMatch(log(), /\/zip|workflow.*run|run.*watch/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});
