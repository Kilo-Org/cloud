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
