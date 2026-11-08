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
  parseNativeProducerJobs,
  parseNativeProducerRuns,
  parseRemoteBranchTip,
  pickDispatchedRun,
  producerPlatformEvidence,
  selectCompatibleProducer,
  type CompatibleProducerExpected,
  type NativeProducerJob,
  type NativeProducerRun,
  type ProducerPlatformEvidence,
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
    pull_requests: [
      { number: 6115, head: { repo: { id: repositoryId } }, base: { repo: { id: repositoryId } } },
    ],
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

const producerExpected: CompatibleProducerExpected = {
  repositoryId,
  workflowId,
  workflowPath,
  headSha: HEAD,
  branch: 'feature/native',
  defaultBranch: 'main',
};

function producerRun(overrides: Partial<NativeProducerRun> = {}): NativeProducerRun {
  return {
    id: 301,
    workflowId,
    path: workflowPath,
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
    headSha: HEAD,
    headBranch: 'feature/native',
    repositoryId,
    headRepositoryId: repositoryId,
    ...overrides,
  };
}

const provenPlatform = (): ProducerPlatformEvidence => 'compatible';

function producerJob(
  name: string,
  status: string,
  conclusion: string | null = null
): NativeProducerJob {
  return { name, status, conclusion };
}

test('producer selection joins a queued or running dispatch on the same branch and commit', () => {
  for (const status of ['queued', 'in_progress']) {
    const selection = selectCompatibleProducer(
      [producerRun({ status })],
      producerExpected,
      provenPlatform
    );
    assert.deepEqual(selection, { kind: 'producer', run: producerRun({ status }) });
  }
  const push = producerRun({ event: 'push', headBranch: 'main' });
  assert.deepEqual(selectCompatibleProducer([push], producerExpected, provenPlatform), {
    kind: 'producer',
    run: push,
  });
});

test('producer selection rejects an incompatible commit, ref, event, or source', () => {
  const incompatible: Partial<NativeProducerRun>[] = [
    { headSha: OTHER },
    { headBranch: 'feature/other' },
    { event: 'push', headBranch: 'feature/native' },
    { event: 'pull_request' },
    { event: 'schedule' },
    { headRepositoryId: 999 },
    { repositoryId: 999 },
    { workflowId: 999 },
    { path: '.github/workflows/other.yml' },
  ];
  for (const overrides of incompatible) {
    assert.deepEqual(
      selectCompatibleProducer([producerRun(overrides)], producerExpected, provenPlatform),
      { kind: 'absent' },
      JSON.stringify(overrides)
    );
  }
  assert.deepEqual(selectCompatibleProducer([], producerExpected, provenPlatform), {
    kind: 'absent',
  });
});

test('producer selection accepts only a successful finished run and prefers an active one', () => {
  for (const conclusion of ['failure', 'cancelled', null]) {
    assert.deepEqual(
      selectCompatibleProducer(
        [producerRun({ status: 'completed', conclusion })],
        producerExpected,
        provenPlatform
      ),
      { kind: 'absent' },
      String(conclusion)
    );
  }
  const ready = producerRun({ id: 302, status: 'completed', conclusion: 'success' });
  assert.deepEqual(selectCompatibleProducer([ready], producerExpected, provenPlatform), {
    kind: 'producer',
    run: ready,
  });
  // A known failed run does not shadow an active producer behind it.
  const failed = producerRun({ id: 303, status: 'completed', conclusion: 'failure' });
  assert.deepEqual(
    selectCompatibleProducer([failed, ready, producerRun()], producerExpected, provenPlatform),
    { kind: 'producer', run: producerRun() }
  );
  assert.deepEqual(selectCompatibleProducer([failed, ready], producerExpected, provenPlatform), {
    kind: 'producer',
    run: ready,
  });
});

test('producer selection lets a proven platform win and never reads unknown as absent', () => {
  const wrongPlatform = producerRun({ id: 302 });
  const unknownPlatform = producerRun({ id: 303 });
  const compatible = producerRun({ id: 301 });
  const evidence = (run: NativeProducerRun): ProducerPlatformEvidence =>
    run.id === 301 ? 'compatible' : run.id === 302 ? 'incompatible' : 'unknown';
  // A wrong-platform or unknown candidate listed first does not shadow a
  // compatible producer behind it.
  assert.deepEqual(
    selectCompatibleProducer(
      [wrongPlatform, unknownPlatform, compatible],
      producerExpected,
      evidence
    ),
    { kind: 'producer', run: compatible }
  );
  assert.deepEqual(
    selectCompatibleProducer([wrongPlatform, unknownPlatform], producerExpected, evidence),
    { kind: 'unknown' }
  );
  assert.deepEqual(selectCompatibleProducer([wrongPlatform], producerExpected, evidence), {
    kind: 'absent',
  });
  // A failed run's unknown platform does not block the selection.
  const failedUnknown = producerRun({ id: 303, status: 'completed', conclusion: 'cancelled' });
  assert.deepEqual(
    selectCompatibleProducer([failedUnknown, wrongPlatform], producerExpected, evidence),
    { kind: 'absent' }
  );
});

test('producer platform evidence needs positive jobs proof for a manual dispatch', () => {
  const manual = producerRun();
  // Main push is known all-platform by the workflow, no jobs needed.
  assert.equal(
    producerPlatformEvidence(producerRun({ event: 'push', headBranch: 'main' }), [], 'android'),
    'compatible'
  );
  for (const status of ['queued', 'in_progress']) {
    assert.equal(
      producerPlatformEvidence(manual, [producerJob('android', status)], 'android'),
      'compatible'
    );
  }
  assert.equal(
    producerPlatformEvidence(manual, [producerJob('android', 'completed', 'success')], 'android'),
    'compatible'
  );
  assert.equal(
    producerPlatformEvidence(manual, [producerJob('android', 'completed', 'skipped')], 'android'),
    'incompatible'
  );
  // A queued run whose gate has not produced a platform job yet is unknown,
  // even when the other platform's job already exists — one platform job
  // per workflow must appear for the requested platform itself.
  for (const jobs of [
    [],
    [producerJob('gate', 'in_progress')],
    [producerJob('gate', 'completed', 'success'), producerJob('ios', 'in_progress')],
    [producerJob('android', 'in_progress'), producerJob('android', 'queued')],
    [
      producerJob('android', 'completed', 'success'),
      producerJob('android', 'completed', 'skipped'),
    ],
  ]) {
    assert.equal(
      producerPlatformEvidence(manual, jobs, 'android'),
      'unknown',
      JSON.stringify(jobs)
    );
  }
  // Evidence is per requested platform.
  assert.equal(
    producerPlatformEvidence(manual, [producerJob('ios', 'in_progress')], 'ios'),
    'compatible'
  );
});

test('producer listing parse fails closed on any unverifiable entry', () => {
  const apiRun = {
    id: 301,
    workflow_id: workflowId,
    path: workflowPath,
    event: 'workflow_dispatch',
    status: 'queued',
    conclusion: null,
    head_sha: HEAD,
    head_branch: 'feature/native',
    repository: { id: repositoryId },
    head_repository: { id: repositoryId },
  };
  assert.deepEqual(parseNativeProducerRuns({ workflow_runs: [apiRun] }), [
    producerRun({ status: 'queued' }),
  ]);
  for (const malformed of [
    { ...apiRun, id: '301' },
    { ...apiRun, head_branch: null },
    { ...apiRun, head_sha: 'abc' },
    { ...apiRun, repository: null },
    null,
  ]) {
    assert.throws(
      () => parseNativeProducerRuns({ workflow_runs: [apiRun, malformed] }),
      /Invalid native producer listing/,
      JSON.stringify(malformed)
    );
  }
  for (const listing of [null, {}, { workflow_runs: {} }, []]) {
    assert.throws(() => parseNativeProducerRuns(listing), /Invalid native producer listing/);
  }
});

test('producer jobs parse fails closed on malformed or foreign jobs evidence', () => {
  const apiJob = {
    id: 11,
    run_id: 301,
    name: 'android',
    status: 'in_progress',
    conclusion: null,
  };
  assert.deepEqual(parseNativeProducerJobs({ total_count: 1, jobs: [apiJob] }, 301), [
    producerJob('android', 'in_progress'),
  ]);
  for (const listing of [
    null,
    {},
    { total_count: 2, jobs: [apiJob] },
    { total_count: 1, jobs: [{ ...apiJob, run_id: 999 }] },
    { total_count: 1, jobs: [{ ...apiJob, name: '' }] },
    { total_count: 1, jobs: [null] },
  ]) {
    assert.throws(
      () => parseNativeProducerJobs(listing, 301),
      /Invalid native producer jobs listing/,
      JSON.stringify(listing)
    );
  }
});

test('remote branch tip parse accepts only the requested branch commit', () => {
  assert.equal(
    parseRemoteBranchTip(
      { ref: 'refs/heads/feature/native', object: { sha: HEAD, type: 'commit' } },
      'feature/native'
    ),
    HEAD
  );
  for (const input of [
    null,
    {},
    { ref: 'refs/heads/main', object: { sha: HEAD, type: 'commit' } },
    { ref: 'refs/heads/feature/native', object: { sha: HEAD, type: 'tag' } },
    { ref: 'refs/heads/feature/native', object: { sha: 'abc', type: 'commit' } },
    { ref: 'refs/heads/feature/native', object: null },
  ]) {
    assert.throws(
      () => parseRemoteBranchTip(input, 'feature/native'),
      /Invalid remote branch tip response/,
      JSON.stringify(input)
    );
  }
});

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
  withOfflineArtifacts(
    [artifact],
    { 301: { ...trustedRun(), head_sha: OTHER, pull_requests: null } },
    invoke => {
      assert.equal(
        JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`))[0]?.id,
        401
      );
    }
  );
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
    ...Object.keys(trustedRun())
      .filter(key => key !== 'pull_requests')
      .map(key => ({ [key]: null })),
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

test('validation scope accepts the same PR across consumer commits without authorizing installation', () => {
  const run = { ...trustedRun(), event: 'pull_request', head_branch: 'feature/native' };
  withOfflineArtifacts([nativeArtifact()], { 301: run }, invoke => {
    assert.equal(
      JSON.parse(
        invoke(
          `native.findNativeArtifacts(${JSON.stringify(nativeName)}, undefined, ${JSON.stringify(OTHER)}, {pullRequestNumber:6115,headRepositoryId:101})`
        )
      )[0]?.id,
      401
    );
    assert.deepEqual(
      JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`)),
      []
    );
  });
});

test('validation lookup rejects another PR, source repository, or base repository', () => {
  for (const pullRequests of [
    [],
    null,
    [{ number: 6116, head: { repo: { id: 101 } }, base: { repo: { id: 101 } } }],
    [{ number: 6115, head: { repo: { id: 999 } }, base: { repo: { id: 101 } } }],
    [{ number: 6115, head: { repo: { id: 101 } }, base: { repo: { id: 999 } } }],
  ]) {
    const run = { ...trustedRun(), event: 'pull_request', pull_requests: pullRequests };
    withOfflineArtifacts([nativeArtifact()], { 301: run }, invoke => {
      assert.deepEqual(
        JSON.parse(
          invoke(
            `native.findNativeArtifacts(${JSON.stringify(nativeName)}, undefined, undefined, {pullRequestNumber:6115,headRepositoryId:101})`
          )
        ),
        []
      );
    });
  }
});

test('validation scope preserves canonical run and source SHA verification', () => {
  for (const invalid of [
    { head_sha: OTHER },
    { workflow_id: 999 },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { repository: { id: 999 } },
    { head_repository: { id: 999 } },
    { path: '.github/workflows/other.yml' },
  ]) {
    withOfflineArtifacts(
      [nativeArtifact()],
      { 301: { ...trustedRun(), event: 'pull_request', ...invalid } },
      invoke => {
        assert.deepEqual(
          JSON.parse(
            invoke(
              `native.findNativeArtifacts(${JSON.stringify(nativeName)}, undefined, undefined, {pullRequestNumber:6115,headRepositoryId:101})`
            )
          ),
          [],
          JSON.stringify(invalid)
        );
      }
    );
  }
});

test('validation lookup binds fork PR artifacts to the requested source repository', () => {
  const artifact = nativeArtifact();
  artifact.workflow_run.head_repository_id = 999;
  const run = {
    ...trustedRun(),
    event: 'pull_request',
    head_repository: { id: 999 },
    pull_requests: [{ number: 6115, head: { repo: { id: 999 } }, base: { repo: { id: 101 } } }],
  };
  withOfflineArtifacts([artifact], { 301: run }, invoke => {
    assert.equal(
      JSON.parse(
        invoke(
          `native.findNativeArtifacts(${JSON.stringify(nativeName)}, undefined, undefined, {pullRequestNumber:6115,headRepositoryId:999})`
        )
      )[0]?.id,
      401
    );
    assert.deepEqual(
      JSON.parse(
        invoke(
          `native.findNativeArtifacts(${JSON.stringify(nativeName)}, undefined, undefined, {pullRequestNumber:6115,headRepositoryId:101})`
        )
      ),
      []
    );
    assert.deepEqual(
      JSON.parse(invoke(`native.findNativeArtifacts(${JSON.stringify(nativeName)})`)),
      []
    );
  });
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

const producerBranch = 'feature/native';
const dispatchedRunId = 999;

function producerApiRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 301,
    workflow_id: workflowId,
    path: workflowPath,
    event: 'workflow_dispatch',
    status: 'in_progress',
    conclusion: null,
    head_sha: HEAD,
    head_branch: producerBranch,
    repository: { id: repositoryId },
    head_repository: { id: repositoryId },
    pull_requests: [],
    ...overrides,
  };
}

function dispatchedApiRun(): Record<string, unknown> {
  return producerApiRun({ id: dispatchedRunId, status: 'completed', conclusion: 'success' });
}

function producerApiJob(
  runId: number,
  name: string,
  status: string,
  conclusion: string | null = null
): Record<string, unknown> {
  const slot = name === 'gate' ? 1 : name === 'ios' ? 2 : 3;
  return { id: runId * 10 + slot, run_id: runId, name, status, conclusion };
}

// Jobs proving a manual run produces Android: the Android job is live (or
// finished non-skipped) and the iOS job was skipped by the gate.
function androidProducerJobs(
  runId = 301,
  status = 'in_progress',
  conclusion: string | null = null
): Record<string, unknown>[] {
  return [
    producerApiJob(runId, 'gate', 'completed', 'success'),
    producerApiJob(runId, 'ios', 'completed', 'skipped'),
    producerApiJob(runId, 'android', status, conclusion),
  ];
}

// Jobs proving a manual run is iOS-only for an Android request.
function iosOnlyProducerJobs(runId: number): Record<string, unknown>[] {
  return [
    producerApiJob(runId, 'gate', 'completed', 'success'),
    producerApiJob(runId, 'ios', 'in_progress'),
    producerApiJob(runId, 'android', 'completed', 'skipped'),
  ];
}

type ProducerScenario = {
  producerRuns: unknown[];
  runsBefore: Record<string, unknown>;
  runsAfter: Record<string, unknown>;
  jobs?: Record<string, unknown[]>;
  artifactsAfterProducer?: unknown[];
  artifactsAfterDispatch?: unknown[];
  artifactsAfterFirstLookup?: unknown[];
  watchExitCodes?: Record<string, number>;
  producerLookupFailures?: number;
  advanceLocalAfterWatch?: boolean;
  advanceRemoteAfterWatch?: boolean;
  remoteTipResponse?: unknown;
};

// Offline end-to-end fetch: stub `gh`, `git`, and `unzip` on PATH. State
// lives in marker files so the artifact and run views advance when a run is
// watched, exactly when the real services would publish them.
function withProducerScenario(
  scenario: ProducerScenario,
  use: (invoke: (expression: string) => string, log: () => string, dir: string) => void
): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-producer-'));
  const logPath = path.join(dir, 'commands.jsonl');
  const unexpectedPath = path.join(dir, 'unexpected.jsonl');
  const fixture = {
    repository: { id: repositoryId, default_branch: 'main' },
    workflow: { id: workflowId, path: workflowPath, state: 'active' },
    producerRuns: scenario.producerRuns,
    runsBefore: scenario.runsBefore,
    runsAfter: scenario.runsAfter,
    jobs: scenario.jobs ?? {},
    artifactsAfterProducer: scenario.artifactsAfterProducer ?? [],
    artifactsAfterDispatch: scenario.artifactsAfterDispatch ?? [],
    artifactsAfterFirstLookup: scenario.artifactsAfterFirstLookup ?? null,
    watchExitCodes: scenario.watchExitCodes ?? {},
    producerLookupFailures: scenario.producerLookupFailures ?? 0,
    advanceRemoteAfterWatch: scenario.advanceRemoteAfterWatch ?? false,
    remoteTipResponse: scenario.remoteTipResponse ?? null,
  };
  fs.writeFileSync(logPath, '');
  fs.writeFileSync(unexpectedPath, '');
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = ${JSON.stringify(dir)};
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const fixture = ${JSON.stringify(fixture)};
const prefix = 'repos/{owner}/{repo}';
const marker = name => fs.existsSync(path.join(dir, name));
const bump = name => {
  const file = path.join(dir, name);
  const next = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;
  fs.writeFileSync(file, String(next));
  return next;
};
const unexpected = () => {
  fs.appendFileSync(${JSON.stringify(unexpectedPath)}, JSON.stringify(args) + '\\n');
  process.stderr.write('unexpected offline gh command: ' + JSON.stringify(args));
  process.exit(91);
};
if (args[0] === 'run' && args[1] === 'watch') {
  const id = args[2];
  fs.writeFileSync(path.join(dir, 'watch-' + id), '');
  fs.writeFileSync(path.join(dir, id === '${dispatchedRunId}' ? 'dispatch-watched' : 'producer-watched'), '');
  process.exit(fixture.watchExitCodes[id] ?? 0);
}
if (args[0] === 'workflow' && args[1] === 'run') {
  fs.writeFileSync(path.join(dir, 'dispatched'), '');
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(marker('dispatched') ? [{ databaseId: ${dispatchedRunId}, headSha: ${JSON.stringify(HEAD)} }] : []));
  process.exit(0);
}
if (args.length !== 2 || args[0] !== 'api') unexpected();
const endpoint = args[1];
if (endpoint.startsWith(prefix + '/actions/artifacts/') && endpoint.endsWith('/zip')) {
  process.stdout.write('fake-zip-bytes');
  process.exit(0);
}
let result;
if (endpoint === prefix + '/git/ref/heads/${producerBranch}') {
  if (fixture.remoteTipResponse !== null) result = fixture.remoteTipResponse;
  else {
    const sha = fixture.advanceRemoteAfterWatch && marker('producer-watched') ? ${JSON.stringify(OTHER)} : ${JSON.stringify(HEAD)};
    result = { ref: 'refs/heads/${producerBranch}', object: { sha, type: 'commit' } };
  }
}
else if (endpoint === prefix) result = fixture.repository;
else if (endpoint === prefix + '/actions/workflows/mobile-native-build.yml') result = fixture.workflow;
else if (endpoint === prefix + '/actions/workflows/mobile-native-build.yml/runs?head_sha=${HEAD}&per_page=30') {
  if (bump('producer-lookups') <= fixture.producerLookupFailures) {
    process.stderr.write('transient producer lookup failure');
    process.exit(1);
  }
  result = { workflow_runs: fixture.producerRuns };
} else if (endpoint === prefix + '/actions/artifacts?name=${nativeName}&per_page=100') {
  const lookups = bump('artifact-lookups');
  const artifacts = marker('dispatch-watched')
    ? fixture.artifactsAfterDispatch
    : marker('producer-watched')
      ? fixture.artifactsAfterProducer
      : fixture.artifactsAfterFirstLookup && lookups > 1
        ? fixture.artifactsAfterFirstLookup
        : [];
  result = { artifacts };
} else if (endpoint.startsWith(prefix + '/actions/runs/') && endpoint.endsWith('/jobs?per_page=100')) {
  const id = endpoint.slice((prefix + '/actions/runs/').length, -'/jobs?per_page=100'.length);
  const jobs = fixture.jobs[id];
  if (jobs !== undefined) result = { total_count: jobs.length, jobs };
} else if (endpoint.startsWith(prefix + '/actions/runs/')) {
  const id = endpoint.slice((prefix + '/actions/runs/').length);
  result = marker('watch-' + id) ? fixture.runsAfter[id] : fixture.runsBefore[id];
}
if (result === undefined) unexpected();
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const advanced = ${scenario.advanceLocalAfterWatch ? 'true' : 'false'} && fs.existsSync(${JSON.stringify(dir)} + '/producer-watched');
const head = advanced ? ${JSON.stringify(OTHER)} : ${JSON.stringify(HEAD)};
if (JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])) process.stdout.write(head + '\\n');
else if (JSON.stringify(args) === JSON.stringify(['rev-parse', '--abbrev-ref', 'HEAD'])) process.stdout.write(${JSON.stringify(producerBranch)} + '\\n');
else if (JSON.stringify(args) === JSON.stringify(['rev-parse', '@{u}'])) process.stdout.write(head + '\\n');
else {
  fs.appendFileSync(${JSON.stringify(unexpectedPath)}, JSON.stringify(args) + '\\n');
  process.exit(92);
}
`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dir, 'unzip'),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dest = args[args.indexOf('-d') + 1];
fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(path.join(dest, 'Kilo.apk'), 'apk-bytes');
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

function fetchScenarioApk(invoke: (expression: string) => string, dir: string): string {
  return invoke(
    `native.fetchAndroidApk({nativeHash: 'provenance', destDir: ${JSON.stringify(dir)}})`
  );
}

test('fetch joins an in-progress compatible producer and dispatches nothing', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: producerApiRun() },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'success' }) },
      jobs: { 301: androidProducerJobs() },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
    },
    (invoke, log, dir) => {
      const target = path.join(dir, 'Kilo-remote.apk');
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), target);
      assert.equal(fs.readFileSync(target, 'utf8'), 'apk-bytes');
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["workflow","run"|cancel/);
      assert.match(log(), /artifacts\/401\/zip/);
    }
  );
});

test('fetch retries a transient producer lookup failure, then joins the producer', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun({ status: 'queued' })],
      runsBefore: { 301: producerApiRun({ status: 'queued' }) },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'success' }) },
      jobs: { 301: androidProducerJobs(301, 'queued') },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
      producerLookupFailures: 1,
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["workflow","run"/);
    }
  );
});

test('fetch stops without dispatch when producer lookup remains unavailable', () => {
  withProducerScenario(
    { producerRuns: [producerApiRun()], runsBefore: {}, runsAfter: {}, producerLookupFailures: 3 },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","watch"|\/zip/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch reuses a ready producer without watching or dispatching', () => {
  const ready = producerApiRun({ status: 'completed', conclusion: 'success' });
  withProducerScenario(
    {
      producerRuns: [ready],
      runsBefore: { 301: ready },
      runsAfter: { 301: ready },
      jobs: { 301: androidProducerJobs(301, 'completed', 'success') },
      artifactsAfterFirstLookup: [nativeArtifact(401, 301)],
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.doesNotMatch(log(), /\["run","watch"|\["workflow","run"/);
      assert.match(log(), /artifacts\/401\/zip/);
    }
  );
});

test('fetch dispatch after a joined producer fails never downloads its artifact', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: producerApiRun() },
      runsAfter: {
        301: producerApiRun({ status: 'completed', conclusion: 'failure' }),
        999: dispatchedApiRun(),
      },
      jobs: { 301: androidProducerJobs() },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
      artifactsAfterDispatch: [nativeArtifact(401, 301), nativeArtifact(402, 999)],
      watchExitCodes: { 301: 1 },
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["workflow","run"/);
      assert.match(log(), /artifacts\/402\/zip/);
      assert.doesNotMatch(log(), /artifacts\/401\/zip|cancel/);
    }
  );
});

test('fetch dispatches when the only producer is for another commit', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun({ head_sha: OTHER })],
      runsBefore: {},
      runsAfter: { 999: dispatchedApiRun() },
      artifactsAfterDispatch: [nativeArtifact(402, 999)],
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["workflow","run"/);
      assert.doesNotMatch(log(), /\["run","watch","301"/);
      assert.match(log(), /artifacts\/402\/zip/);
    }
  );
});

test('fetch does not join a newer iOS-only producer and is not shadowed by it', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun({ id: 302, status: 'queued' }), producerApiRun()],
      runsBefore: { 301: producerApiRun(), 302: producerApiRun({ id: 302, status: 'queued' }) },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'success' }) },
      jobs: { 301: androidProducerJobs(), 302: iosOnlyProducerJobs(302) },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["run","watch","302"|\["workflow","run"|cancel/);
      assert.match(log(), /artifacts\/401\/zip/);
    }
  );
});

test('fetch dispatches when the only producer is proven iOS-only', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: producerApiRun() },
      runsAfter: { 999: dispatchedApiRun() },
      jobs: { 301: iosOnlyProducerJobs(301) },
      artifactsAfterDispatch: [nativeArtifact(402, 999)],
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["workflow","run"/);
      assert.doesNotMatch(log(), /\["run","watch","301"/);
      assert.match(log(), /artifacts\/402\/zip/);
    }
  );
});

test('fetch joins a main push producer without jobs evidence', () => {
  const push = { event: 'push', head_branch: 'main' };
  withProducerScenario(
    {
      producerRuns: [producerApiRun(push)],
      runsBefore: { 301: producerApiRun(push) },
      runsAfter: { 301: producerApiRun({ ...push, status: 'completed', conclusion: 'success' }) },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["workflow","run"|\/jobs\?/);
    }
  );
});

test('fetch stops without dispatch while a queued manual producer platform is unproven', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun({ status: 'queued' })],
      runsBefore: { 301: producerApiRun({ status: 'queued' }) },
      runsAfter: {},
      // The gate has not decided yet, so no platform job exists to prove
      // this queued manual run builds Android.
      jobs: { 301: [producerApiJob(301, 'gate', 'queued')] },
    },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","watch"|\/zip|cancel/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch stops without dispatch on a malformed producer listing entry', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun(), { id: 'not-a-run' }],
      runsBefore: {},
      runsAfter: {},
      jobs: { 301: androidProducerJobs() },
    },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","watch"|\/zip|cancel/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch stops without dispatch on malformed producer detail', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: {} },
      runsAfter: {},
      jobs: { 301: androidProducerJobs() },
    },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","watch"|\/zip|cancel/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch rediscovers an older producer after the joined producer fails', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun({ id: 302 }), producerApiRun()],
      runsBefore: { 301: producerApiRun(), 302: producerApiRun({ id: 302 }) },
      runsAfter: {
        301: producerApiRun({ status: 'completed', conclusion: 'success' }),
        302: producerApiRun({ id: 302, status: 'completed', conclusion: 'failure' }),
      },
      jobs: { 301: androidProducerJobs(), 302: androidProducerJobs(302) },
      // The failed run's claimed artifact is listed first; only the
      // successful older producer's artifact may download.
      artifactsAfterProducer: [nativeArtifact(402, 302), nativeArtifact(401, 301)],
      watchExitCodes: { 302: 1 },
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["run","watch","302"/);
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["workflow","run"|cancel/);
      assert.match(log(), /artifacts\/401\/zip/);
      assert.doesNotMatch(log(), /artifacts\/402\/zip/);
    }
  );
});

test('fetch reuses the artifact when the watch fails but the producer succeeded', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: producerApiRun() },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'success' }) },
      jobs: { 301: androidProducerJobs() },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
      // The watcher itself exits nonzero (timeout/network) even though
      // the run completes successfully behind it.
      watchExitCodes: { 301: 1 },
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["workflow","run"|cancel/);
      assert.match(log(), /artifacts\/401\/zip/);
    }
  );
});

test('fetch stops without dispatch when the local ref advances during the join', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: producerApiRun() },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'failure' }) },
      jobs: { 301: androidProducerJobs() },
      watchExitCodes: { 301: 1 },
      advanceLocalAfterWatch: true,
    },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","list"|\/zip|cancel/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch stops without dispatch when the remote tip advances during the join', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun()],
      runsBefore: { 301: producerApiRun() },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'failure' }) },
      jobs: { 301: androidProducerJobs() },
      watchExitCodes: { 301: 1 },
      advanceRemoteAfterWatch: true,
    },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.match(log(), /git\/ref\/heads\/feature\/native/);
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","list"|\/zip|cancel/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch stops without dispatch on an unverifiable remote tip response', () => {
  withProducerScenario(
    {
      producerRuns: [],
      runsBefore: {},
      runsAfter: {},
      remoteTipResponse: {},
    },
    (invoke, log, dir) => {
      assert.equal(fetchScenarioApk(invoke, dir), 'undefined');
      assert.equal(log().split('git/ref/heads/').length - 1, 3, 'bounded tip reads are retried');
      assert.doesNotMatch(log(), /\["workflow","run"|\["run","list"|\/zip|cancel/);
      assert.equal(fs.existsSync(path.join(dir, 'Kilo-remote.apk')), false);
    }
  );
});

test('fetch re-evaluates remaining candidates when the picked producer just failed', () => {
  withProducerScenario(
    {
      producerRuns: [producerApiRun({ id: 302 }), producerApiRun()],
      // Detail reads (before any watch) show the newest producer already
      // failed; the older active producer behind it must be joined instead
      // of declaring the producer absent.
      runsBefore: {
        301: producerApiRun(),
        302: producerApiRun({ id: 302, status: 'completed', conclusion: 'failure' }),
      },
      runsAfter: { 301: producerApiRun({ status: 'completed', conclusion: 'success' }) },
      jobs: { 301: androidProducerJobs(), 302: androidProducerJobs(302) },
      artifactsAfterProducer: [nativeArtifact(401, 301)],
    },
    (invoke, log, dir) => {
      assert.equal(JSON.parse(fetchScenarioApk(invoke, dir)), path.join(dir, 'Kilo-remote.apk'));
      assert.match(log(), /\["run","watch","301"/);
      assert.doesNotMatch(log(), /\["run","watch","302"|\["workflow","run"|cancel/);
      assert.match(log(), /artifacts\/401\/zip/);
    }
  );
});
