import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

const rootPath = '.github/workflows/ci.yml';
const mobilePath = '.github/workflows/kilo-app-ci.yml';
const checkPath = 'scripts/stacked-ci.test.mjs';
const command = `node --test ${checkPath}`;
const originalMobilePaths = [
  'apps/mobile/**',
  'packages/trpc/**',
  'apps/web/src/routers/**',
  'packages/app-shared/**',
  'packages/kilo-chat/**',
  'packages/kilo-chat-hooks/**',
  'packages/event-service/**',
  'packages/notifications/**',
  'packages/cloud-agent-sdk/**',
  'pnpm-lock.yaml',
  mobilePath,
];

function readWorkflows() {
  return [rootPath, mobilePath].map(path =>
    load(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
  );
}

function admits(workflow, event, base, files) {
  if (!(event in workflow.on)) return false;
  const trigger = workflow.on[event] ?? {};
  if (trigger.branches && !trigger.branches.some(pattern => matchesGlob(base, pattern)))
    return false;
  if (trigger['branches-ignore']?.some(pattern => matchesGlob(base, pattern))) return false;
  if (
    trigger.paths &&
    !files.some(file => trigger.paths.some(pattern => matchesGlob(file, pattern)))
  )
    return false;
  return (
    !trigger['paths-ignore'] ||
    files.some(file => !trigger['paths-ignore'].some(pattern => matchesGlob(file, pattern)))
  );
}

function validateCheck(workflow, jobName) {
  const job = workflow.jobs[jobName];
  assert.equal(job.if, undefined, `${jobName}: check job must be unconditional`);
  assert.equal(job.needs, undefined, `${jobName}: check job must not depend on filtering`);
  assert.equal(job['continue-on-error'], undefined, `${jobName}: check failure must fail the job`);
  const steps = job.steps;
  const checks = steps.filter(step => step.run === command);
  assert.equal(checks.length, 1, `${jobName}: run the check exactly once`);
  const step = checks[0];
  assert.equal(step.if, undefined, `${jobName}: check step must be unconditional`);
  assert.equal(
    step['continue-on-error'],
    undefined,
    `${jobName}: check failure must not be ignored`
  );
  assert.equal(
    step['working-directory'] ??
      job.defaults?.run?.['working-directory'] ??
      workflow.defaults?.run?.['working-directory'] ??
      '.',
    '.',
    `${jobName}: check must run from the repository root`
  );
  const installIndex = steps.findIndex(item => /\bpnpm\b.*\binstall\b/.test(item.run ?? ''));
  const checkIndex = steps.indexOf(step);
  assert.ok(installIndex >= 0 && installIndex < checkIndex, `${jobName}: install before the check`);
  if (jobName === 'changes') {
    const filterIndex = steps.findIndex(item => item.id === 'filter');
    assert.ok(filterIndex > checkIndex, 'changes: check before filtering');
  }
}

function validate(root, mobile) {
  for (const workflow of [root, mobile]) {
    assert.ok('pull_request' in workflow.on, 'pull_request must be enabled');
    const trigger = workflow.on.pull_request ?? {};
    assert.equal(trigger.branches, undefined, 'pull_request must admit every base');
    assert.equal(trigger['branches-ignore'], undefined, 'pull_request must not exclude bases');
    assert.deepEqual(workflow.on.push.branches, ['main'], 'push must remain main-only');
    assert.equal(workflow.on.push['branches-ignore'], undefined);
  }
  assert.equal(root.on.pull_request?.paths, undefined, 'root admission must not filter paths');
  assert.equal(root.on.pull_request?.['paths-ignore'], undefined);
  assert.deepEqual(root.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.deepEqual(mobile.permissions, { contents: 'read' });
  assert.ok('workflow_call' in mobile.on, 'mobile release caller must remain enabled');
  for (const event of ['push', 'pull_request']) {
    assert.deepEqual(mobile.on[event].paths, [...originalMobilePaths, rootPath, checkPath]);
    assert.equal(mobile.on[event]['paths-ignore'], undefined);
  }
  validateCheck(root, 'changes');
  validateCheck(mobile, 'test');
}

test('both live workflows validate triggers and unconditional check invocations', () => {
  validate(...readWorkflows());
});

for (const base of ['main', 'stack/level-one', 'arbitrary/parent-42']) {
  for (const file of [rootPath, mobilePath, checkPath, 'apps/mobile/src/app/_layout.tsx']) {
    test(`isolated ${file} admits both workflows on ${base}`, () => {
      for (const workflow of readWorkflows()) {
        assert.equal(admits(workflow, 'pull_request', base, [file]), true);
      }
    });
  }
}

test('mobile keeps every existing path and main-only pushes', () => {
  const [root, mobile] = readWorkflows();
  for (const pattern of originalMobilePaths) {
    const file = pattern.replace('**', 'fixture.ts');
    assert.equal(admits(mobile, 'pull_request', 'stack/parent', [file]), true);
    assert.equal(admits(mobile, 'push', 'main', [file]), true);
    assert.equal(admits(mobile, 'push', 'stack/parent', [file]), false);
  }
  assert.equal(admits(root, 'push', 'stack/parent', [rootPath]), false);
  assert.equal(admits(mobile, 'pull_request', 'stack/parent', ['README.md']), false);
});

test('mobile catches an isolated root main-only regression on a stacked base', () => {
  const [root, mobile] = readWorkflows();
  root.on.pull_request = { branches: ['main'] };
  assert.equal(admits(root, 'pull_request', 'stack/parent', [rootPath]), false);
  assert.equal(admits(mobile, 'pull_request', 'stack/parent', [rootPath]), true);
  assert.throws(() => validate(root, mobile), /pull_request must admit every base/);
});

for (const [index, jobName] of [
  [0, 'changes'],
  [1, 'test'],
]) {
  for (const defect of [
    'missing',
    'conditional-step',
    'conditional-job',
    'ignored',
    'directory',
    'before-install',
  ]) {
    test(`${jobName} rejects a ${defect} check`, () => {
      const workflows = readWorkflows();
      const job = workflows[index].jobs[jobName];
      const checkIndex = job.steps.findIndex(step => step.run === command);
      const check = job.steps[checkIndex];
      if (defect === 'missing') job.steps.splice(checkIndex, 1);
      if (defect === 'conditional-step') check.if = 'false';
      if (defect === 'conditional-job') job.if = 'false';
      if (defect === 'ignored') check['continue-on-error'] = true;
      if (defect === 'directory') job.defaults = { run: { 'working-directory': 'apps/mobile' } };
      if (defect === 'before-install') job.steps.unshift(...job.steps.splice(checkIndex, 1));
      assert.throws(() => validate(...workflows), assert.AssertionError);
    });
  }
}

test('CI keeps its existing event types and excludes tag pushes', () => {
  const [root, mobile] = readWorkflows();
  assert.deepEqual(Object.keys(root.on).sort(), ['pull_request', 'push']);
  assert.deepEqual(Object.keys(mobile.on).sort(), ['pull_request', 'push', 'workflow_call']);
  assert.deepEqual(root.on.push, { branches: ['main'] });
  assert.deepEqual(mobile.on.push, {
    branches: ['main'],
    paths: [...originalMobilePaths, rootPath, checkPath],
  });
});

test('admission file pushes start both workflows only on main', () => {
  for (const workflow of readWorkflows()) {
    for (const file of [rootPath, mobilePath, checkPath]) {
      assert.equal(admits(workflow, 'push', 'main', [file]), true);
      assert.equal(admits(workflow, 'push', 'stack/level-one', [file]), false);
      assert.equal(admits(workflow, 'push', 'arbitrary/parent-42', [file]), false);
    }
  }
});

test('unrelated files start root CI but not mobile CI', () => {
  const [root, mobile] = readWorkflows();
  for (const [event, base] of [
    ['pull_request', 'stack/parent'],
    ['push', 'main'],
  ]) {
    assert.equal(admits(root, event, base, ['README.md']), true);
    assert.equal(admits(mobile, event, base, ['README.md']), false);
  }
});

test('CI jobs keep the workflow read-only permissions', () => {
  for (const workflow of readWorkflows()) {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.equal(job.permissions, undefined, `${name}: do not override read-only permissions`);
    }
  }
});

test('only the main failure notification can access CI secrets', () => {
  const [root, mobile] = readWorkflows();
  const { 'notify-main-failure': notification, ...jobs } = root.jobs;
  assert.doesNotMatch(JSON.stringify({ ...root, jobs }), /\bsecrets\b/);
  assert.doesNotMatch(JSON.stringify(mobile), /\bsecrets\b/);
  assert.equal(
    notification.if,
    "${{ always() && github.ref == 'refs/heads/main' && contains(join(needs.*.result, ','), 'failure') }}"
  );
  assert.equal(
    notification.steps[0].with.webhook,
    '${{ secrets.DEPLOY_NOTIFY_SLACK_WEBHOOK_URL }}'
  );
});

const release = load(
  readFileSync(new URL('../.github/workflows/kilo-app-release.yml', import.meta.url), 'utf8')
);

test('release retains only scheduled and manual entry points', () => {
  assert.deepEqual(release.on, {
    schedule: [{ cron: '0 6 * * *' }],
    workflow_dispatch: null,
  });
});

test('release validation keeps the local CI call without inherited secrets', () => {
  const [, mobile] = readWorkflows();
  assert.deepEqual(release.jobs.validate, { uses: `./${mobilePath}` });
  assert.equal(mobile.on.workflow_call, null);
});

for (const [name, needs] of [
  ['preflight', ['check-changes']],
  ['build-and-submit', ['check-changes', 'validate', 'preflight']],
]) {
  test(`release ${name} requires changed main and its existing checks`, () => {
    assert.equal(
      release.jobs[name].if,
      "needs.check-changes.outputs.should_build == 'true' && github.ref == 'refs/heads/main'"
    );
    assert.deepEqual(release.jobs[name].needs, needs);
  });
}

test('release retains its existing permission boundaries', () => {
  assert.deepEqual(release.permissions, { contents: 'write' });
  assert.deepEqual(release.jobs.preflight.permissions, { contents: 'read' });
  assert.equal(release.jobs['build-and-submit'].permissions, undefined);
});
