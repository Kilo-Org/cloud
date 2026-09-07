import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

// The "Detect changes" step in ci.yml runs dorny/paths-filter, which calls the
// GitHub API to list the PR's changed files. That call fails without retry on
// transient connection resets ("other side closed"), so the workflow keeps a
// second attempt whose outputs the job falls back to. This suite pins that
// wiring: without it a single dropped connection fails every check gated on
// this job, and drifted filters between the two attempts would let the retry
// evaluate different paths than the first attempt reported.

const actionRef = 'dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d';
const filterNames = ['kilocode_backend', 'cloud_agent_next'];
const fallbackOutput = name =>
  `\${{ steps.filter.outputs.${name} || steps.filter_retry.outputs.${name} }}`;

function readChangesJob() {
  const workflow = load(
    readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  );
  return workflow.jobs.changes;
}

function firstAttempt(job) {
  const step = job.steps.find(item => item.id === 'filter');
  assert.ok(step, 'changes: first Detect changes step (id filter) is missing');
  return step;
}

function retryStep(job) {
  const step = job.steps.find(item => item.id === 'filter_retry');
  assert.ok(step, 'changes: Detect changes retry step (id filter_retry) is missing');
  return step;
}

function validate(job) {
  const first = firstAttempt(job);
  const retry = retryStep(job);
  assert.ok(
    job.steps.indexOf(retry) > job.steps.indexOf(first),
    'changes: retry must run after the first Detect changes attempt'
  );
  assert.equal(first.uses, actionRef, 'changes: first attempt must use the pinned paths-filter');
  assert.equal(retry.uses, actionRef, 'changes: retry must use the same pinned paths-filter');
  assert.equal(
    first['continue-on-error'],
    true,
    'changes: first attempt must tolerate failure so the retry can run'
  );
  assert.equal(
    retry['continue-on-error'],
    undefined,
    'changes: a persistent filter failure must fail the job, never be ignored'
  );
  assert.equal(
    retry.if,
    "steps.filter.outcome == 'failure'",
    'changes: retry must run only after a failed first attempt'
  );
  assert.equal(
    retry.with.filters,
    first.with.filters,
    'changes: retry filters must be byte-identical to the first attempt'
  );
  assert.deepEqual(
    Object.keys(load(first.with.filters)).sort(),
    [...filterNames].sort(),
    'changes: filters must keep the expected filter names'
  );
  for (const name of filterNames) {
    assert.equal(
      job.outputs[name],
      fallbackOutput(name),
      `changes: output ${name} must fall back to the retry attempt`
    );
  }
}

test('ci.yml retries the changes filter after a transient GitHub API failure', () => {
  validate(readChangesJob());
});

for (const defect of [
  'missing-retry',
  'fatal-first-attempt',
  'ignored-retry',
  'unconditional-retry',
  'drifted-filters',
  'missing-fallback',
]) {
  test(`changes rejects ${defect}`, () => {
    const job = readChangesJob();
    const first = job.steps.find(item => item.id === 'filter');
    const retry = job.steps.find(item => item.id === 'filter_retry');
    if (defect === 'missing-retry') job.steps.splice(job.steps.indexOf(retry), 1);
    if (defect === 'fatal-first-attempt') delete first['continue-on-error'];
    if (defect === 'ignored-retry') retry['continue-on-error'] = true;
    if (defect === 'unconditional-retry') delete retry.if;
    if (defect === 'drifted-filters')
      retry.with.filters = retry.with.filters.replace("'apps/web/src/**'", "'apps/web/src2/**'");
    if (defect === 'missing-fallback')
      job.outputs.kilocode_backend = '${{ steps.filter.outputs.kilocode_backend }}';
    assert.throws(() => validate(job), assert.AssertionError);
  });
}
