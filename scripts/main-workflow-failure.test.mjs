import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { load } from 'js-yaml';

function readWorkflow(name) {
  return load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

const workflow = readWorkflow('notify-main-failure');
const job = workflow.jobs.notify;
const failedRun = {
  name: 'kilo-app Release',
  conclusion: 'failure',
  event: 'push',
  head_branch: 'main',
  head_repository: { full_name: 'Kilo-Org/cloud' },
  head_sha: '1234567890abcdef1234567890abcdef12345678',
  html_url: 'https://github.com/Kilo-Org/cloud/actions/runs/36890981580',
  actor: { login: 'merge-author' },
  run_attempt: 2,
};

function shouldNotify(run) {
  return (
    workflow.on.workflow_run.workflows.includes(run.name) &&
    runInNewContext(job.if, {
      github: { repository: 'Kilo-Org/cloud', event: { workflow_run: run } },
    })
  );
}

test('watches completed main workflows without checking out code or granting permissions', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_run']);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.deepEqual(workflow.on.workflow_run.branches, ['main']);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency, undefined);
  assert.equal(job['timeout-minutes'], 5);
  assert.ok(job.steps.every(step => step.uses && !step.uses.includes('checkout')));
});

test('covers every push workflow, except E2E which already sends its own notification', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const pushWorkflows = readdirSync(directory)
    .filter(name => /\.ya?ml$/.test(name))
    .map(name => load(readFileSync(new URL(name, directory), 'utf8')))
    .filter(item => item.on?.push && item.name !== 'Cloud Agent E2E tests')
    .map(item => item.name)
    .sort();
  assert.deepEqual([...workflow.on.workflow_run.workflows].sort(), pushWorkflows);
});

test('notifies for the failed mobile release and CI including initial change-detection failures', () => {
  assert.equal(shouldNotify(failedRun), true);
  assert.equal(shouldNotify({ ...failedRun, name: 'CI' }), true);
  assert.equal(readWorkflow('ci').jobs['notify-main-failure'], undefined);
});

for (const conclusion of ['cancelled', 'success', 'skipped', 'neutral', 'timed_out', null]) {
  test(`does not notify for a ${conclusion} run`, () => {
    assert.equal(shouldNotify({ ...failedRun, conclusion }), false);
  });
}

for (const event of ['pull_request', 'workflow_dispatch', 'schedule', 'workflow_run']) {
  test(`does not notify for ${event} runs`, () => {
    assert.equal(shouldNotify({ ...failedRun, event }), false);
  });
}

test('does not notify for another branch or repository', () => {
  assert.equal(shouldNotify({ ...failedRun, head_branch: 'feature/test' }), false);
  assert.equal(shouldNotify({ ...failedRun, head_repository: { full_name: 'fork/cloud' } }), false);
});

test('preserves the richer E2E notification without sending a duplicate', () => {
  assert.equal(shouldNotify({ ...failedRun, name: 'Cloud Agent E2E tests' }), false);
  const e2e = readWorkflow('cloud-agent-e2e-tests');
  assert.equal(e2e.name, 'Cloud Agent E2E tests');
  assert.ok(e2e.jobs['notify-failure']);
});

test('Slack payload uses the failed run metadata and safely serializes special characters', async () => {
  const run = {
    ...failedRun,
    name: 'Release "quoted"\n<test>',
    actor: { login: 'original-actor' },
  };
  let payload;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('context', 'core', job.steps[0].with.script)(
    {
      payload: { workflow_run: run },
      serverUrl: 'https://github.com',
      repo: { owner: 'Kilo-Org', repo: 'cloud' },
      sha: 'different-notification-workflow-sha',
      actor: 'different-notification-actor',
    },
    {
      setOutput(name, value) {
        assert.equal(name, 'payload');
        payload = JSON.parse(value);
      },
    }
  );
  assert.equal(payload.text, `${run.name} failed on main: ${run.html_url}`);
  assert.deepEqual(payload.blocks[1].text, { type: 'plain_text', text: run.name });
  assert.deepEqual(payload.blocks[2].fields, [
    {
      type: 'mrkdwn',
      text: `*Commit:*\n<https://github.com/Kilo-Org/cloud/commit/${run.head_sha}|1234567>`,
    },
    { type: 'plain_text', text: 'Triggered by: original-actor' },
    { type: 'plain_text', text: 'Attempt: 2' },
  ]);
  assert.equal(payload.blocks[3].text.text, `<${run.html_url}|View failed workflow run>`);
});

test('sends the serialized payload to the existing Slack incoming webhook', () => {
  const slack = job.steps[1];
  assert.match(slack.uses, /^slackapi\/slack-github-action@[a-f0-9]{40}$/);
  assert.equal(slack.with.webhook, '${{ secrets.DEPLOY_NOTIFY_SLACK_WEBHOOK_URL }}');
  assert.equal(slack.with['webhook-type'], 'incoming-webhook');
  assert.equal(slack.with.payload, '${{ steps.payload.outputs.payload }}');
});
