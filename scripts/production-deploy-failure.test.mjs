import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { load } from 'js-yaml';

function readWorkflow(name) {
  return load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

const workflow = readWorkflow('notify-production-deploy-failure');
const job = workflow.jobs.notify;
const failedRun = {
  name: 'Deploy to Production',
  conclusion: 'failure',
  event: 'schedule',
  head_branch: 'main',
  head_repository: { full_name: 'Kilo-Org/cloud' },
  html_url: 'https://github.com/Kilo-Org/cloud/actions/runs/37800478766',
  run_attempt: 1,
};

function shouldNotify(run) {
  return (
    workflow.on.workflow_run.workflows.includes(run.name) &&
    runInNewContext(job.if, {
      github: { repository: 'Kilo-Org/cloud', event: { workflow_run: run } },
    })
  );
}

test('watches completed production deployments on main without checkout or token permissions', () => {
  assert.deepEqual(workflow.on, {
    workflow_run: {
      workflows: [readWorkflow('deploy-production').name],
      types: ['completed'],
      branches: ['main'],
    },
  });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency, undefined);
  assert.equal(job.needs, undefined);
  assert.equal(job['timeout-minutes'], 5);
  assert.ok(job.steps.every(step => step.uses && !step.uses.includes('checkout')));
});

test('notifies for the scheduled production failure independently of the failed job', () => {
  assert.equal(shouldNotify(failedRun), true);
  assert.equal(shouldNotify({ ...failedRun, run_attempt: 2 }), true);
  assert.equal(
    readWorkflow('notify-main-failure').on.workflow_run.workflows.includes(failedRun.name),
    false
  );
});

for (const conclusion of ['cancelled', 'success', 'skipped', 'neutral', 'timed_out', null]) {
  test(`does not notify for a ${conclusion} deployment`, () => {
    assert.equal(shouldNotify({ ...failedRun, conclusion }), false);
  });
}

for (const event of ['push', 'pull_request', 'workflow_dispatch', 'workflow_run']) {
  test(`does not notify for ${event} deployments`, () => {
    assert.equal(shouldNotify({ ...failedRun, event }), false);
  });
}

test('does not notify for staging, unrelated workflows, another branch or repository', () => {
  assert.equal(shouldNotify({ ...failedRun, name: readWorkflow('deploy-staging').name }), false);
  assert.equal(shouldNotify({ ...failedRun, name: 'CI' }), false);
  assert.equal(shouldNotify({ ...failedRun, head_branch: 'feature/test' }), false);
  assert.equal(shouldNotify({ ...failedRun, head_repository: { full_name: 'fork/cloud' } }), false);
});

test('Slack payload links the failed deployment and safely serializes its metadata', async () => {
  const run = { ...failedRun, name: 'Deploy "quoted"\n<test>', run_attempt: 2 };
  let payload;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('context', 'core', job.steps[0].with.script)(
    { payload: { workflow_run: run } },
    {
      setOutput(name, value) {
        assert.equal(name, 'payload');
        payload = JSON.parse(value);
      },
    }
  );
  assert.equal(payload.text, `Scheduled production deployment failed on main: ${run.html_url}`);
  assert.equal(payload.blocks[0].text.text, 'Scheduled production deployment failed');
  assert.deepEqual(payload.blocks[1].text, { type: 'plain_text', text: run.name });
  assert.deepEqual(payload.blocks[2].fields, [
    { type: 'plain_text', text: 'Branch: main' },
    { type: 'plain_text', text: 'Attempt: 2' },
  ]);
  assert.equal(payload.blocks[3].text.text, `<${run.html_url}|View failed production deployment>`);
});

test('sends the payload to the existing Slack webhook and surfaces delivery failures', () => {
  const slack = job.steps[1];
  assert.match(slack.uses, /^slackapi\/slack-github-action@[a-f0-9]{40}$/);
  assert.equal(slack.with.errors, true);
  assert.equal(slack.with.webhook, '${{ secrets.DEPLOY_NOTIFY_SLACK_WEBHOOK_URL }}');
  assert.equal(slack.with['webhook-type'], 'incoming-webhook');
  assert.equal(slack.with.payload, '${{ steps.payload.outputs.payload }}');
  assert.equal(slack['continue-on-error'], undefined);
});

test('CI runs the production deployment notification regression tests', () => {
  assert.ok(
    readWorkflow('ci').jobs.changes.steps.some(
      step => step.run === 'node --test scripts/production-deploy-failure.test.mjs'
    )
  );
});
