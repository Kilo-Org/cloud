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

// The `mobile-native-build` workflow only ran on a pull request that edited
// the workflow file itself, so a PR that changed a native input (PR 6115's
// react-native patch broke RCTComponentViewFactory.mm) reached main with the
// app never compiled. This suite pins the fix: the native inputs are in the
// pull_request trigger, a native-input run publishes the plain
// mobile-native-<platform>-<nativeHash> artifact a host installs, a
// workflow-file run keeps the PR-scoped prefix hosts never install, and a
// platform whose artifact exists is skipped. A push run only skips on a
// durable artifact: the one-day pull_request artifact must not stop main from
// publishing its own build.

type WorkflowStep = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  if?: string;
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
  assert.equal(workflow.jobs.ios.if, "needs.gate.outputs.need_ios == 'true'");
  assert.equal(workflow.jobs.android.if, "needs.gate.outputs.need_android == 'true'");
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
    artifactExists: name => {
      queried.push(name);
      return true;
    },
  });
  assert.deepEqual(gate, { prefix: '', needIos: false, needAndroid: false });
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
    artifactExists: name => {
      queried.push(name);
      return false;
    },
  });
  assert.deepEqual(gate, { prefix: '', needIos: true, needAndroid: true });
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
    artifactExists: name => {
      queried.push(name);
      return false;
    },
  });
  assert.deepEqual(gate, { prefix: 'pr6115-abc12345-', needIos: true, needAndroid: true });
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
    artifactExists: () => false,
  });
  assert.deepEqual(gate, { prefix: '', needIos: true, needAndroid: true });
});

test('a push run asks for a durable artifact so a one-day one cannot skip it', () => {
  const requested: boolean[] = [];
  decideNativeBuildGate({
    eventName: 'push',
    platform: 'all',
    prNumber: '',
    workflowHash: '',
    changedFiles: [],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    artifactExists: (_name, options) => {
      requested.push(options.requireDurable);
      // A one-day artifact is live but not durable, so the push still builds.
      return false;
    },
  });
  assert.deepEqual(requested, [true, true]);
});

test('a pull_request run accepts the artifact it publishes itself', () => {
  const requested: boolean[] = [];
  decideNativeBuildGate({
    eventName: 'pull_request',
    platform: 'all',
    prNumber: '6115',
    workflowHash: 'abc12345',
    changedFiles: ['patches/react-native.patch'],
    iosHash: 'ioshash',
    androidHash: 'androidhash',
    artifactExists: (_name, options) => {
      requested.push(options.requireDurable);
      return false;
    },
  });
  assert.deepEqual(requested, [false, false]);
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
    artifactExists: name => {
      queried.push(name);
      return false;
    },
  });
  assert.deepEqual(gate, { prefix: '', needIos: true, needAndroid: false });
  assert.deepEqual(queried, [artifactName('ios', 'ioshash')]);
});

// Run the shipped gate CLI with a stub `gh` so the workflow wiring (env in,
// GITHUB_OUTPUT out, artifact lookups) is exercised, not just the pure
// decision.
function artifact(createdDaysAgo: number, retentionDays: number): string {
  const created = Date.now() - createdDaysAgo * 24 * 60 * 60 * 1000;
  return JSON.stringify({
    expired: false,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + retentionDays * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function runGateCli(options: {
  eventName?: string;
  changedFiles?: string[];
  artifacts?: string[];
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
  const changed = (options.changedFiles ?? []).map(file => `'${file}'`).join(' ');
  const artifacts = JSON.stringify({
    artifacts: (options.artifacts ?? []).map(item => JSON.parse(item)),
  });
  fs.writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$@" >> "${ghLog}"`,
      'case "$*" in',
      `  *"/pulls/"*) printf '%s\\n' ${changed} ;;`,
      `  *"/actions/artifacts?name="*) printf '%s\\n' '${artifacts}' ;;`,
      '  *) echo "unexpected gh args: $*" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  try {
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'dev/local/mobile-native-gate.ts', 'ioshash', 'androidhash'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          GITHUB_EVENT_NAME: options.eventName ?? 'pull_request',
          GITHUB_REPOSITORY: 'Kilo-Org/kilocode',
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
        .map(line => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    return { outputs, ghLog: fs.readFileSync(ghLog, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the gate CLI skips both platforms and keeps the plain name when artifacts exist', () => {
  const { outputs, ghLog } = runGateCli({
    changedFiles: ['patches/react-native.patch', 'apps/mobile/app.config.ts'],
    artifacts: [artifact(0, 1)],
  });
  assert.deepEqual(outputs, { prefix: '', need_ios: 'false', need_android: 'false' });
  assert.ok(ghLog.includes('name=mobile-native-ios-ioshash'), ghLog);
  assert.ok(ghLog.includes('name=mobile-native-android-androidhash'), ghLog);
});

// The finding this pins: the gate lists every non-expired artifact under the
// plain name, so before the fix a push run skipped main's durable build when
// the only artifact was the one-day one a pull_request run published.
test('a push run does not skip on the one-day pull_request artifact', () => {
  const { outputs, ghLog } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 1)],
  });
  assert.deepEqual(outputs, { prefix: '', need_ios: 'true', need_android: 'true' });
  assert.ok(ghLog.includes('name=mobile-native-ios-ioshash'), ghLog);
  assert.ok(ghLog.includes('name=mobile-native-android-androidhash'), ghLog);
});

test('a push run skips on the durable artifact main published', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 90)],
  });
  assert.deepEqual(outputs, { prefix: '', need_ios: 'false', need_android: 'false' });
});

test('a push run skips when a durable artifact sits beside the one-day one', () => {
  const { outputs } = runGateCli({
    eventName: 'push',
    artifacts: [artifact(0, 1), artifact(0, 90)],
  });
  assert.deepEqual(outputs, { prefix: '', need_ios: 'false', need_android: 'false' });
});

test('a workflow_dispatch run does not skip on the one-day pull_request artifact', () => {
  const { outputs } = runGateCli({
    eventName: 'workflow_dispatch',
    artifacts: [artifact(0, 1)],
  });
  assert.deepEqual(outputs, { prefix: '', need_ios: 'true', need_android: 'true' });
});

test('the gate CLI keeps an edited workflow out of the installed namespace', () => {
  const workflowHash = createHash('sha256')
    .update(fs.readFileSync(path.join(repoRoot, NATIVE_WORKFLOW_PATH)))
    .digest('hex')
    .slice(0, 8);
  const { outputs, ghLog } = runGateCli({
    changedFiles: ['patches/react-native.patch', NATIVE_WORKFLOW_PATH],
  });
  assert.deepEqual(outputs, {
    prefix: `pr6115-${workflowHash}-`,
    need_ios: 'true',
    need_android: 'true',
  });
  assert.match(ghLog, new RegExp(`name=pr6115-${workflowHash}-mobile-native-ios-ioshash`));
  assert.doesNotMatch(ghLog, /artifacts\?name=mobile-native-ios-ioshash/);
});
