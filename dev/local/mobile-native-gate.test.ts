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
  type ArtifactLookup,
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
  const iosUpload = workflow.jobs.ios.steps.find(item =>
    (item.uses ?? '').startsWith('actions/upload-artifact')
  );
  assert.equal(
    iosUpload?.with?.name,
    '${{ needs.gate.outputs.prefix }}mobile-native-ios-${{ needs.gate.outputs.ios_hash }}'
  );
  const androidUpload = workflow.jobs.android.steps.find(item =>
    (item.uses ?? '').startsWith('actions/upload-artifact')
  );
  assert.equal(
    androidUpload?.with?.name,
    '${{ needs.gate.outputs.prefix }}mobile-native-android-${{ needs.gate.outputs.android_hash }}'
  );
});

test('the gate job exposes the promote outputs the workflow reads', () => {
  const outputs = readWorkflow().jobs.gate.outputs ?? {};
  for (const key of [
    'promote_ios',
    'promote_android',
    'promote_ios_artifact_id',
    'promote_android_artifact_id',
    'promote_ios_name',
    'promote_android_name',
  ]) {
    assert.ok(
      outputs[key]?.includes(`steps.decide.outputs.${key}`),
      `gate output ${key} is missing`
    );
  }
});

// One native build takes longer than the gap between two pushes of the same
// native inputs, so the gate's artifact lookup cannot see the build in
// flight. The job-level slot plus the re-check is what stops a duplicate.
// A pull_request run owns its slot per ref: one slot per nativeHash made
// sibling pull requests cancel each other's pending build, because GitHub keeps
// a single pending job per group. A push build keeps the nativeHash slot,
// keyed on the event as well, so it is never the pending job that a later
// pull_request job cancels and main keeps its durable artifact.
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

test('a promote job copies the short-lived artifact under the durable name', () => {
  const workflow = readWorkflow();
  for (const platform of ['ios', 'android'] as const) {
    const promote = workflow.jobs[`promote_${platform}`];
    assert.ok(promote, `promote_${platform} job is missing`);
    assert.equal(promote.needs, 'gate');
    assert.equal(promote.if, `needs.gate.outputs.promote_${platform} == 'true'`);
    // A cancelled promote reports result == 'cancelled', which the build job
    // reads as "not success" and answers with a full build. So the promote job
    // must never take a slot that GitHub can cancel.
    assert.equal(promote.concurrency, undefined, `promote_${platform} must not take a slot`);
    const upload = promote.steps.find(item =>
      (item.uses ?? '').startsWith('actions/upload-artifact')
    );
    assert.equal(upload?.with?.name, `\${{ needs.gate.outputs.promote_${platform}_name }}`);
    assert.equal(upload?.with?.['retention-days'], 90);
  }
});

test('a failed promote still builds the platform, and a skipped one does not disable it', () => {
  const workflow = readWorkflow();
  for (const platform of ['ios', 'android'] as const) {
    const job = workflow.jobs[platform];
    assert.deepEqual(job.needs, ['gate', `promote_${platform}`]);
    // GitHub skips a job whose `needs` dependency was skipped unless the `if`
    // calls a status function. promote_* is skipped on every run that does not
    // promote, so without `always()` the workflow builds nothing at all. The
    // `!cancelled()` keeps a superseded pull_request run from starting a macOS
    // job after the run-level concurrency cancelled it.
    assert.match(
      job.if ?? '',
      /^always\(\) && !cancelled\(\)/,
      `${platform}: the if needs a status function and a cancellation guard`
    );
    assert.match(job.if ?? '', /needs\.gate\.result == 'success'/);
    assert.match(job.if ?? '', new RegExp(`needs\\.gate\\.outputs\\.need_${platform} == 'true'`));
    assert.match(job.if ?? '', new RegExp(`needs\\.promote_${platform}\\.result != 'success'`));
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

const MISSING: ArtifactLookup = { state: 'missing' };

function durable(name: string): ArtifactLookup {
  return { state: 'durable', artifact: { id: 7, name } };
}

function short(name: string): ArtifactLookup {
  return { state: 'short', artifact: { id: 9, name } };
}

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
      return durable(name);
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
      return MISSING;
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
      return MISSING;
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
    lookup: () => MISSING,
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: true }, android: { need: true } },
  });
});

test('a push run promotes a trusted short-lived push artifact instead of rebuilding it', () => {
  const gate = decideNativeBuildGate({
    eventName: 'push',
    platform: 'all',
    prNumber: '',
    workflowHash: '',
    changedFiles: [],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: short,
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: {
      ios: { need: false, promote: { id: 9, name: artifactName('ios', 'ioshash') } },
      android: { need: false, promote: { id: 9, name: artifactName('android', 'androidhash') } },
    },
  });
});

test('a workflow_dispatch run promotes the one-day artifact as well', () => {
  const gate = decideNativeBuildGate({
    eventName: 'workflow_dispatch',
    platform: 'all',
    prNumber: '',
    workflowHash: '',
    changedFiles: [],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: short,
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: {
      ios: { need: false, promote: { id: 9, name: artifactName('ios', 'ioshash') } },
      android: { need: false, promote: { id: 9, name: artifactName('android', 'androidhash') } },
    },
  });
});

test('a pull_request run reuses a trusted short-lived artifact and promotes nothing', () => {
  const gate = decideNativeBuildGate({
    eventName: 'pull_request',
    platform: 'all',
    prNumber: '6115',
    workflowHash: 'abc12345',
    changedFiles: ['patches/react-native.patch'],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: short,
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: false }, android: { need: false } },
  });
});

test('a push run skips on the durable artifact main published', () => {
  const gate = decideNativeBuildGate({
    eventName: 'push',
    platform: 'all',
    prNumber: '',
    workflowHash: '',
    changedFiles: [],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    lookup: durable,
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
      return MISSING;
    },
  });
  assert.deepEqual(gate, {
    prefix: '',
    platforms: { ios: { need: true }, android: { need: false } },
  });
  assert.deepEqual(queried, [artifactName('ios', 'ioshash')]);
});

function artifact(
  createdDaysAgo: number,
  retentionDays: number,
  id: number,
  runOverrides: Record<string, unknown> = {}
): string {
  const created = Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000;
  return JSON.stringify({
    id,
    expired: false,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
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
      ...runOverrides,
    },
  });
}

// The gate's outputs as the workflow reads them. `promote` carries the
// artifact the promote job copies. `plan[platform]` omitted means the platform
// is skipped through the `platform` input.
function gateOutputs(plan: {
  prefix?: string;
  ios?: { need: boolean; promote?: { id: number; name: string } };
  android?: { need: boolean; promote?: { id: number; name: string } };
}): Record<string, string> {
  const outputs: Record<string, string> = { prefix: plan.prefix ?? '' };
  for (const platform of ['ios', 'android'] as const) {
    const platformPlan = plan[platform] ?? { need: false };
    outputs[`need_${platform}`] = String(platformPlan.need);
    outputs[`promote_${platform}`] = String(platformPlan.promote !== undefined);
    outputs[`promote_${platform}_artifact_id`] = platformPlan.promote
      ? String(platformPlan.promote.id)
      : '';
    outputs[`promote_${platform}_name`] = platformPlan.promote?.name ?? '';
  }
  return outputs;
}

function runGateCli(options: {
  eventName?: string;
  changedFiles?: string[];
  artifacts?: string[];
  published?: string;
  failLookups?: boolean;
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
          GITHUB_SHA: 'a'.repeat(40),
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
    artifacts: [artifact(0, 1, 11)],
  });
  assert.deepEqual(outputs, gateOutputs({}));
  assert.ok(ghLog.includes('name=mobile-native-ios-ioshash'), ghLog);
  assert.ok(ghLog.includes('name=mobile-native-android-androidhash'), ghLog);
});

test('a push run promotes a trusted short-lived main-push artifact instead of rebuilding', () => {
  const { outputs, ghLog } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 1, 11)],
  });
  assert.deepEqual(
    outputs,
    gateOutputs({
      ios: { need: false, promote: { id: 11, name: 'mobile-native-ios-ioshash' } },
      android: { need: false, promote: { id: 11, name: 'mobile-native-android-androidhash' } },
    })
  );
  assert.ok(ghLog.includes('name=mobile-native-ios-ioshash'), ghLog);
  assert.ok(ghLog.includes('name=mobile-native-android-androidhash'), ghLog);
});

test('a push run skips on the durable artifact main published', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 90, 12)],
  });
  assert.deepEqual(outputs, gateOutputs({}));
});

test('a push run skips when a durable artifact sits beside the one-day one', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 1, 11), artifact(0, 90, 12)],
  });
  assert.deepEqual(outputs, gateOutputs({}));
});

test('a workflow_dispatch run promotes a trusted short-lived manual artifact', () => {
  const { outputs } = runGateCli({
    eventName: 'workflow_dispatch',
    artifacts: [artifact(0, 1, 11, { event: 'workflow_dispatch', head_branch: 'feature/native' })],
  });
  assert.deepEqual(
    outputs,
    gateOutputs({
      ios: { need: false, promote: { id: 11, name: 'mobile-native-ios-ioshash' } },
      android: { need: false, promote: { id: 11, name: 'mobile-native-android-androidhash' } },
    })
  );
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

test('the published check reports the durable artifact to a waiting job', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(0, 90, 12)],
  });
  assert.deepEqual(outputs, { published: 'true' });
});

test('the published check refuses the one-day artifact to a push job', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(0, 1, 11)],
  });
  assert.deepEqual(outputs, { published: 'false' });
});

test('the published check accepts a trusted short-lived artifact for a pull_request job', () => {
  const { outputs } = runGateCli({
    eventName: 'pull_request',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(0, 1, 11)],
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

// An artifact-listing failure must cost at most a duplicate build, never the
// artifact itself: the heavy job falls back to building, and the gate falls
// back to the same decision it makes for a name nobody published.
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

test('the gate CLI rebuilds rather than promotes a short-lived pull-request artifact', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 1, 11, { event: 'pull_request' })],
  });
  assert.deepEqual(outputs, gateOutputs({ ios: { need: true }, android: { need: true } }));
});

test('the published check refuses durable-looking untrusted artifacts', () => {
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
      artifacts: [artifact(0, 90, 12, run)],
    });
    assert.deepEqual(outputs, { published: 'false' }, JSON.stringify(run));
  }
});

test('the gate CLI ignores a newer fork artifact and promotes the trusted manual candidate', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [
      artifact(0, 90, 12, { head_repository: { id: 999 } }),
      artifact(0, 1, 11, { event: 'workflow_dispatch', head_branch: 'feature/native' }),
    ],
  });
  assert.deepEqual(
    outputs,
    gateOutputs({
      ios: { need: false, promote: { id: 11, name: 'mobile-native-ios-ioshash' } },
      android: { need: false, promote: { id: 11, name: 'mobile-native-android-androidhash' } },
    })
  );
});

test('the published check skips an untrusted first artifact and finds a trusted durable push', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    published: 'mobile-native-ios-ioshash',
    artifacts: [artifact(0, 90, 12, { event: 'pull_request' }), artifact(1, 90, 13)],
  });
  assert.deepEqual(outputs, { published: 'true' });
});

test('the published check refuses a manual artifact built from another consumer commit', () => {
  const otherSha = 'b'.repeat(40);
  const otherCommit = JSON.parse(
    artifact(0, 90, 12, {
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
