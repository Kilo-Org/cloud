import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

import {
  NATIVE_WORKFLOW_PATH,
  decideNativeBuildGate,
  pullRequestArtifactPrefix,
} from './mobile-native-gate';
import { artifactName } from './mobile-remote-native';

type WorkflowStep = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
};

type Workflow = {
  on: { pull_request: { paths: string[] }; push: { paths: string[] } };
  concurrency: { group: string; 'cancel-in-progress': string };
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const NATIVE_INPUTS = ['apps/mobile/**', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/**'];

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function readWorkflow(): Workflow {
  return load(
    fs.readFileSync(
      new URL('../../.github/workflows/mobile-native-build.yml', import.meta.url),
      'utf8'
    )
  ) as Workflow;
}

function step(job: WorkflowJob, id: string): WorkflowStep {
  const found = job.steps.find(item => item.id === id);
  assert.ok(found, `gate step ${id} is missing`);
  return found;
}

test('a pull request that changes a native input triggers the native build', () => {
  const { pull_request: pullRequest } = readWorkflow().on;
  for (const path of NATIVE_INPUTS) {
    assert.ok(
      pullRequest.paths.includes(path),
      `pull_request trigger is missing the native input ${path}`
    );
  }
  assert.ok(
    pullRequest.paths.includes(NATIVE_WORKFLOW_PATH),
    'pull_request trigger must still self-validate this workflow file'
  );
});

test('the push trigger keeps every native input', () => {
  const { push } = readWorkflow().on;
  for (const path of [...NATIVE_INPUTS, NATIVE_WORKFLOW_PATH]) {
    assert.ok(push.paths.includes(path), `push trigger is missing ${path}`);
  }
});

test('a superseded pull_request build is cancelled', () => {
  const workflow = readWorkflow();
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' }}"
  );
  assert.equal(workflow.concurrency.group, '${{ github.workflow }}-${{ github.ref }}');
});

test('the gate reads the pull request changed files', () => {
  const workflow = readWorkflow();
  assert.equal(
    workflow.permissions['pull-requests'],
    'read',
    'listing a pull request changed files needs pull-requests: read'
  );
  assert.match(
    step(workflow.jobs.gate, 'decide').run ?? '',
    /mobile-native-gate\.ts/,
    'the gate must delegate the prefix and skip decision to mobile-native-gate.ts'
  );
});

test('a platform is skipped by the gate output it publishes', () => {
  const workflow = readWorkflow();
  assert.match(workflow.jobs.ios.if ?? '', /needs\.gate\.outputs\.need_ios == 'true'/);
  assert.match(workflow.jobs.android.if ?? '', /needs\.gate\.outputs\.need_android == 'true'/);
});

test('each heavy job takes its own pull_request slot, the nativeHash slot elsewhere, and re-checks its artifact', () => {
  const workflow = readWorkflow();
  for (const platform of ['ios', 'android'] as const) {
    const job = workflow.jobs[platform];
    assert.deepEqual(job.concurrency, {
      group:
        `\${{ github.workflow }}-\${{ github.event_name }}-${platform}` +
        `-\${{ github.event_name == 'pull_request' && github.ref || needs.gate.outputs.${platform}_hash }}`,
      'cancel-in-progress': false,
    });
    const published = step(job, 'published');
    assert.match(
      published.run ?? '',
      /--published/,
      `${platform}: the job must re-check its artifact`
    );
    const from = job.steps.indexOf(published);
    for (const later of job.steps.slice(from + 1)) {
      assert.equal(
        later.if,
        "steps.published.outputs.published != 'true'",
        `${platform}: every step after the re-check must skip when another run published`
      );
    }
  }
});

test('only a pull request that edits the workflow file gets the PR prefix', () => {
  assert.equal(
    pullRequestArtifactPrefix({
      prNumber: '6115',
      workflowHash: 'abc12345',
      changedFiles: ['patches/react-native.patch', 'apps/mobile/package.json'],
    }),
    '',
    'a native input change must publish the plain name a host installs'
  );
  assert.equal(
    pullRequestArtifactPrefix({
      prNumber: '6115',
      workflowHash: 'abc12345',
      changedFiles: ['apps/mobile/package.json', NATIVE_WORKFLOW_PATH],
    }),
    'pr6115-abc12345-',
    'editing the workflow must stay out of the install namespace'
  );
});

test('a pull request whose artifacts exist costs one gate job and no macOS runner', () => {
  const queried: string[] = [];
  const gate = decideNativeBuildGate({
    eventName: 'pull_request',
    platform: 'all',
    prNumber: '6115',
    workflowHash: 'abc12345',
    changedFiles: ['apps/mobile/src/screen.tsx'],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: name => {
      queried.push(name);
      return true;
    },
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: false }, android: { need: false } },
  });
  assert.deepEqual(queried, [
    artifactName('ios', 'ioshash'),
    artifactName('android', 'androidhash'),
  ]);
});

test('a pull request that changes a native input builds under the plain name', () => {
  const queried: string[] = [];
  const gate = decideNativeBuildGate({
    eventName: 'pull_request',
    platform: 'all',
    prNumber: '6115',
    workflowHash: 'abc12345',
    changedFiles: ['patches/react-native.patch'],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: name => {
      queried.push(name);
      return false;
    },
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: true }, android: { need: true } },
  });
  assert.deepEqual(queried, [
    artifactName('ios', 'ioshash'),
    artifactName('android', 'androidhash'),
  ]);
});

test('a pull request that edits the workflow never publishes an installable name', () => {
  const queried: string[] = [];
  const gate = decideNativeBuildGate({
    eventName: 'pull_request',
    platform: 'all',
    prNumber: '6115',
    workflowHash: 'abc12345',
    changedFiles: [NATIVE_WORKFLOW_PATH],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: name => {
      queried.push(name);
      return false;
    },
  });
  assert.deepEqual(gate, {
    prefix: 'pr6115-abc12345-',
    platforms: { ios: { need: true }, android: { need: true } },
  });
  assert.deepEqual(queried, [
    `pr6115-abc12345-${artifactName('ios', 'ioshash')}`,
    `pr6115-abc12345-${artifactName('android', 'androidhash')}`,
  ]);
});

test('a push always publishes the plain, installable name', () => {
  const gate = decideNativeBuildGate({
    eventName: 'push',
    platform: 'all',
    prNumber: '',
    workflowHash: '',
    changedFiles: [NATIVE_WORKFLOW_PATH],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: () => false,
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: true }, android: { need: true } },
  });
});

test('a push run skips an existing trusted artifact', () => {
  const gate = decideNativeBuildGate({
    eventName: 'push',
    platform: 'all',
    prNumber: '',
    workflowHash: '',
    changedFiles: [],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: () => true,
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: false }, android: { need: false } },
  });
});

test('the platform input gates a single platform and skips its artifact lookup', () => {
  const queried: string[] = [];
  const gate = decideNativeBuildGate({
    eventName: 'workflow_dispatch',
    platform: 'ios',
    prNumber: '',
    workflowHash: '',
    changedFiles: [],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: name => {
      queried.push(name);
      return false;
    },
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: true }, android: { need: false } },
  });
  assert.deepEqual(queried, [artifactName('ios', 'ioshash')]);
});

function artifact(id: number, runOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    expired: false,
    created_at: '2026-10-27T00:00:00Z',
    expires_at: '2099-01-25T00:00:00Z',
    workflow_run: {
      id: id + 1000,
      repository_id: 101,
      head_repository_id: 101,
      head_sha: 'a'.repeat(40),
    },
    run: {
      id: id + 1000,
      workflow_id: 201,
      path: NATIVE_WORKFLOW_PATH,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'a'.repeat(40),
      head_branch: 'main',
      repository: { id: 101 },
      head_repository: { id: 101 },
      pull_requests: [{ number: 6115, head: { repo: { id: 101 } }, base: { repo: { id: 101 } } }],
      ...runOverrides,
    },
  });
}

function gateOutputs(plan: {
  prefix?: string;
  ios?: { need: boolean };
  android?: { need: boolean };
}): Record<string, string> {
  const outputs: Record<string, string> = { prefix: plan.prefix ?? '' };
  for (const platform of ['ios', 'android'] as const) {
    const platformPlan = plan[platform] ?? { need: false };
    outputs[`need_${platform}`] = String(platformPlan.need);
  }
  return outputs;
}

function runGateCli(options: {
  eventName?: string;
  changedFiles?: string[];
  artifacts?: string[];
  published?: string;
  failLookups?: boolean;
  eventScope?: unknown;
  missingEventPath?: boolean;
  eventContents?: string;
  consumerSha?: string;
}): {
  outputs: Record<string, string>;
  ghLog: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-native-gate-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(dir, 'gh.log');
  const output = path.join(dir, 'github_output');
  fs.writeFileSync(output, '');
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(
    eventPath,
    options.eventContents ??
      JSON.stringify(
        options.eventScope ?? { number: 6115, pull_request: { head: { repo: { id: 101 } } } }
      )
  );
  const unexpected = path.join(dir, 'unexpected.log');
  fs.writeFileSync(unexpected, '');
  const artifacts = (options.artifacts ?? []).map(item => JSON.parse(item));
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)}, args.join(' ') + '\\n');
const artifacts = ${JSON.stringify(artifacts)};
const endpoint = args[1];
const base = 'repos/Kilo-Org/kilocode';
let result;
if (args[0] === 'api' && (args.length === 2 || (endpoint === base + '/pulls/6115/files?per_page=100' && args.length === 5))) {
  if (endpoint === base) result = {id: 101, default_branch: 'main'};
  else if (endpoint === base + '/actions/workflows/mobile-native-build.yml') {
    result = {id: 201, path: ${JSON.stringify(NATIVE_WORKFLOW_PATH)}, state: 'active'};
  } else if (endpoint === base + '/pulls/6115/files?per_page=100' && JSON.stringify(args.slice(2)) === JSON.stringify(['--paginate', '--jq', '.[].filename'])) {
    process.stdout.write(${JSON.stringify((options.changedFiles ?? []).join('\n'))});
    process.exit(0);
  } else if (endpoint.startsWith(base + '/actions/artifacts?name=')) {
    if (${Boolean(options.failLookups)}) {
      process.stderr.write('gh: API rate limit exceeded');
      process.exit(1);
    }
    const query = new URLSearchParams(endpoint.split('?')[1]);
    const name = query.get('name');
    if (query.get('per_page') === '100' && name && /^(pr6115-[a-f0-9]{8}-)?mobile-native-(ios-ioshash|android-androidhash)$/.test(name)) {
      result = {artifacts: artifacts.map(({run, ...item}) => ({...item, name}))};
    }
  } else if (endpoint.startsWith(base + '/actions/runs/')) {
    const id = Number(endpoint.slice((base + '/actions/runs/').length));
    result = artifacts.find(item => item.workflow_run.id === id)?.run;
  }
}
if (result === undefined) {
  fs.appendFileSync(${JSON.stringify(unexpected)}, JSON.stringify(args) + '\\n');
  process.stderr.write('unexpected offline gh command: ' + JSON.stringify(args));
  process.exit(91);
}
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o755 }
  );
  const gateArgs = options.published
    ? ['--published', options.published]
    : ['ioshash', 'androidhash'];
  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'dev/local/mobile-native-gate.ts', ...gateArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          GITHUB_EVENT_NAME: options.eventName ?? 'pull_request',
          GITHUB_REPOSITORY: 'Kilo-Org/kilocode',
          GITHUB_SHA: options.consumerSha ?? 'a'.repeat(40),
          GITHUB_EVENT_PATH: options.missingEventPath ? '' : eventPath,
          PR_NUMBER: '6115',
          PLATFORM: 'all',
          GITHUB_OUTPUT: output,
        },
      }
    );
    const outputs = Object.fromEntries(
      fs
        .readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    assert.equal(fs.readFileSync(unexpected, 'utf8'), '', 'all gh commands must stay offline');
    return { outputs, ghLog: fs.readFileSync(ghLog, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the gate CLI skips both platforms and keeps the plain name when artifacts exist', () => {
  const { outputs, ghLog } = runGateCli({
    changedFiles: ['patches/react-native.patch', 'apps/mobile/app.config.ts'],
    artifacts: [artifact(11)],
  });
  assert.deepEqual(outputs, gateOutputs({}));
  assert.ok(ghLog.includes('name=mobile-native-ios-ioshash'), ghLog);
  assert.ok(ghLog.includes('name=mobile-native-android-androidhash'), ghLog);
});

test('a push run reuses a trusted main-push artifact', () => {
  const { outputs } = runGateCli({ eventName: 'push', artifacts: [artifact(11)] });
  assert.deepEqual(outputs, gateOutputs({}));
});

test('a workflow_dispatch run reuses a manual artifact from the consumer SHA', () => {
  const { outputs } = runGateCli({
    eventName: 'workflow_dispatch',
    artifacts: [artifact(11, { event: 'workflow_dispatch', head_branch: 'feature/native' })],
  });
  assert.deepEqual(outputs, gateOutputs({}));
});

test('the gate CLI keeps an edited workflow out of the installed namespace', () => {
  const workflowHash = createHash('sha256')
    .update(fs.readFileSync(path.join(repoRoot, NATIVE_WORKFLOW_PATH)))
    .digest('hex')
    .slice(0, 8);
  const { outputs, ghLog } = runGateCli({
    changedFiles: ['patches/react-native.patch', NATIVE_WORKFLOW_PATH],
  });
  assert.deepEqual(
    outputs,
    gateOutputs({
      prefix: `pr6115-${workflowHash}-`,
      ios: { need: true },
      android: { need: true },
    })
  );
  assert.match(ghLog, new RegExp(`name=pr6115-${workflowHash}-mobile-native-ios-ioshash`));
  assert.doesNotMatch(ghLog, /artifacts\?name=mobile-native-ios-ioshash/);
});

test('the published check reports a trusted artifact to a waiting job', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(12)],
  });
  assert.deepEqual(outputs, { published: 'true' });
});

test('the published check accepts a trusted artifact for a pull_request job', () => {
  const { outputs } = runGateCli({
    eventName: 'pull_request',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(11)],
  });
  assert.deepEqual(outputs, { published: 'true' });
});

test('the published check reports missing when nothing is published', () => {
  const { outputs } = runGateCli({
    eventName: 'pull_request',
    published: 'mobile-native-ios-ioshash',
  });
  assert.deepEqual(outputs, { published: 'false' });
});

test('a failing artifact lookup makes the heavy job build', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    failLookups: true,
  });
  assert.deepEqual(outputs, { published: 'false' });
});

test('a failing artifact lookup makes the gate build', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    failLookups: true,
  });
  assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
});

test('a push gate rejects a pull-request artifact', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(11, { event: 'pull_request' })],
  });
  assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
});

test('the published check refuses untrusted artifacts', () => {
  for (const run of [
    { event: 'pull_request' },
    { head_repository: { id: 999 } },
    { workflow_id: 999 },
    { path: '.github/workflows/other.yml' },
    { event: 'schedule' },
    { status: 'in_progress' },
    { head_sha: 'b'.repeat(40) },
    { repository: null },
  ]) {
    const { outputs } = runGateCli({
      eventName: 'push',
      published: 'mobile-native-ios-ioshash',
      artifacts: [artifact(12, run)],
    });
    assert.deepEqual(outputs, { published: 'false' }, JSON.stringify(run));
  }
});

test('the gate CLI ignores a newer fork artifact and reuses the trusted manual candidate', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [
      artifact(12, { head_repository: { id: 999 } }),
      artifact(11, { event: 'workflow_dispatch', head_branch: 'feature/native' }),
    ],
  });
  assert.deepEqual(outputs, gateOutputs({}));
});

test('the published check skips an untrusted first artifact and finds a trusted main push', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(12, { event: 'pull_request' }), artifact(13)],
  });
  assert.deepEqual(outputs, { published: 'true' });
});

test('the published check refuses a manual artifact built from another consumer commit', () => {
  const otherSha = 'b'.repeat(40);
  const otherCommit = JSON.parse(
    artifact(12, {
      event: 'workflow_dispatch',
      head_branch: 'feature/native',
      head_sha: otherSha,
    })
  );
  otherCommit.workflow_run.head_sha = otherSha;
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    artifacts: [JSON.stringify(otherCommit)],
  });
  assert.deepEqual(outputs, { published: 'false' });
});

test('the PR gate reuses its own nativeHash artifact across unrelated consumer commits', () => {
  for (const changedFiles of [['apps/mobile/src/screen.tsx'], [NATIVE_WORKFLOW_PATH]]) {
    const { outputs } = runGateCli({
      changedFiles,
      consumerSha: 'b'.repeat(40),
      artifacts: [artifact(11, { event: 'pull_request', head_branch: 'feature/native' })],
    });
    assert.equal(outputs.need_ios, 'false');
    assert.equal(outputs.need_android, 'false');
    assert.deepEqual(Object.keys(outputs).sort(), ['need_android', 'need_ios', 'prefix']);
  }
});

test('the PR gate rejects artifacts outside its PR and repository scope', () => {
  for (const eventScope of [
    { number: 6116, pull_request: { head: { repo: { id: 101 } } } },
    { number: 6115, pull_request: { head: { repo: { id: 999 } } } },
  ]) {
    const { outputs } = runGateCli({
      eventScope,
      artifacts: [artifact(11, { event: 'pull_request' })],
    });
    assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
  }
});

test('the PR gate rejects incomplete or mismatched run validation metadata', () => {
  for (const pullRequests of [
    [],
    null,
    [{ number: 6116, head: { repo: { id: 101 } }, base: { repo: { id: 101 } } }],
    [{ number: 6115, head: { repo: { id: 999 } }, base: { repo: { id: 101 } } }],
    [{ number: 6115, head: { repo: { id: 101 } }, base: { repo: { id: 999 } } }],
  ]) {
    const { outputs } = runGateCli({
      artifacts: [artifact(11, { event: 'pull_request', pull_requests: pullRequests })],
    });
    assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
  }
});

test('missing or malformed PR event scope fails closed for PR artifacts', () => {
  for (const options of [
    { missingEventPath: true },
    { eventContents: '{invalid' },
    { eventScope: {} },
    { eventScope: { number: 0, pull_request: { head: { repo: { id: 101 } } } } },
    { eventScope: { number: '6115', pull_request: { head: { repo: { id: 101 } } } } },
    { eventScope: { number: 6115, pull_request: { head: { repo: { id: -1 } } } } },
    { eventScope: { number: 6115, pull_request: { head: { repo: { id: 1.5 } } } } },
  ]) {
    const { outputs } = runGateCli({
      ...options,
      artifacts: [artifact(11, { event: 'pull_request' })],
    });
    assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
  }
});

test('the waiting PR job uses the same validation scope as the gate', () => {
  for (const number of [6115, 6116]) {
    const { outputs } = runGateCli({
      published: 'mobile-native-ios-ioshash',
      consumerSha: 'b'.repeat(40),
      eventScope: { number, pull_request: { head: { repo: { id: 101 } } } },
      artifacts: [artifact(11, { event: 'pull_request' })],
    });
    assert.deepEqual(outputs, { published: String(number === 6115) });
  }
});

test('a manual gate with no consumer SHA rejects manual artifacts', () => {
  const { outputs } = runGateCli({
    eventName: 'workflow_dispatch',
    consumerSha: '',
    artifacts: [artifact(11, { event: 'workflow_dispatch', head_branch: 'feature/native' })],
  });
  assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
});
