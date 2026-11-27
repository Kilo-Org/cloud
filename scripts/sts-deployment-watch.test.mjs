import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

import {
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  STALE_AFTER_MS,
  STS_SCRIPTS,
  WINDOW_OVERLAP_MS,
  deployJobSpans,
  escapeMrkdwn,
  health,
  isStale,
  runsToCheck,
  slackPayload,
  unexpectedDeployments,
  watch,
  windowStart,
} from './sts-deployment-watch.mjs';

const readWorkflow = name =>
  load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
const watchWorkflow = readWorkflow('sts-deployment-watch');
const healthWorkflow = readWorkflow('sts-deployment-watch-health');
const stsConfig = readFileSync(new URL('../services/sts/wrangler.jsonc', import.meta.url), 'utf8');

const NOW = Date.parse('2026-11-27T12:00:00Z');
const at = iso => Date.parse(iso);
const SINCE = at('2026-11-27T11:00:00Z');
const GUARD = "github.repository == 'Kilo-Org/cloud' && github.ref == 'refs/heads/main'";

function run(path, jobs) {
  return { run: { id: 1, path }, jobs };
}

function job(
  name,
  started,
  completed,
  conclusion = completed ? 'success' : null,
  status = completed ? 'completed' : 'in_progress'
) {
  return {
    name,
    started_at: started,
    completed_at: completed,
    conclusion,
    status,
    html_url: `https://x/${name}`,
  };
}

function deployment(environment, created, id = created, extra = {}) {
  return {
    environment,
    script: STS_SCRIPTS[environment],
    deployment: {
      id,
      created_on: created,
      source: 'wrangler',
      annotations: { 'workers/triggered_by': 'deployment' },
      ...extra,
    },
  };
}

const productionSpans = deployJobSpans(
  [
    run('.github/workflows/deploy-production.yml', [
      job('deploy-workers / Deploy services/sts', '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z'),
    ]),
  ],
  NOW
);

test('both workflows run on main of the canonical repository with read-only permissions', () => {
  for (const workflow of [watchWorkflow, healthWorkflow]) {
    assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' });
  }
  assert.equal(watchWorkflow.jobs.watch.if, GUARD);
  assert.equal(healthWorkflow.jobs.health.if, GUARD);
  const steps = watchWorkflow.jobs.watch.steps;
  const check = steps.find(item => item.id === 'watch');
  assert.equal(check.run, 'node scripts/sts-deployment-watch.mjs watch');
  assert.equal(check.env.CLOUDFLARE_TOKEN, '${{ secrets.STS_WATCH_CLOUDFLARE_TOKEN }}');
  assert.deepEqual(
    steps.slice(-2).map(step => step.if),
    ["steps.watch.outputs.payload != ''", 'failure()']
  );
  assert.doesNotMatch(steps.at(-1).with.payload, /steps\./);
  const healthCheck = healthWorkflow.jobs.health.steps.find(item => item.id === 'health');
  assert.equal(healthCheck.run, 'node scripts/sts-deployment-watch.mjs health');
  assert.equal(healthCheck.env.CLOUDFLARE_TOKEN, undefined);
  assert.equal(
    healthWorkflow.jobs.health.steps.at(-1).if,
    "steps.health.outputs.stale == 'true' || failure()"
  );
});

test('watches the STS script names that services/sts/wrangler.jsonc deploys', () => {
  assert.match(stsConfig, /^ {2}"name": "sts",$/m);
  assert.match(stsConfig, /"name": "sts-staging",/);
  assert.deepEqual(STS_SCRIPTS, { production: 'sts', staging: 'sts-staging' });
});

test('opens the window at the previous success less the overlap, and says when it clamped', () => {
  assert.deepEqual(windowStart(NOW, null), { since: NOW - DEFAULT_WINDOW_MS, clamped: false });
  assert.deepEqual(windowStart(NOW, NOW - 900_000), {
    since: NOW - 900_000 - WINDOW_OVERLAP_MS,
    clamped: false,
  });
  assert.deepEqual(windowStart(NOW, NOW - 30 * 24 * 3600_000), {
    since: NOW - MAX_WINDOW_MS,
    clamped: true,
  });
});

test('checks only runs of this repository on main, from a deploy event, updated in the window', () => {
  const base = {
    head_branch: 'main',
    head_repository: { full_name: 'Kilo-Org/cloud' },
    event: 'push',
  };
  const runs = [
    { ...base, id: 1, updated_at: '2026-11-27T10:00:00Z' },
    { ...base, id: 2, updated_at: '2026-11-27T10:59:00Z' },
    { ...base, id: 3, updated_at: '2026-11-27T11:30:00Z' },
    { ...base, id: 4, updated_at: '2026-11-27T11:30:00Z', head_branch: 'feature' },
    {
      ...base,
      id: 5,
      updated_at: '2026-11-27T11:30:00Z',
      head_repository: { full_name: 'fork/cloud' },
    },
    { ...base, id: 6, updated_at: '2026-11-27T11:30:00Z', event: 'pull_request' },
    { ...base, id: 7, updated_at: '2026-11-27T11:30:00Z', event: 'workflow_dispatch' },
  ];
  assert.deepEqual(
    runsToCheck(runs, SINCE, 'Kilo-Org/cloud').map(item => item.id),
    [2, 3, 7]
  );
});

test('a wrangler deployment inside an STS deploy job of its environment is expected', () => {
  const spans = deployJobSpans(
    [
      run('.github/workflows/deploy-production.yml', [
        job('deploy-workers / Deploy services/sts', '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z'),
      ]),
      run('.github/workflows/deploy-staging.yml', [
        job('deploy-workers / Deploy services/sts', '2026-11-27T11:40:00Z', null),
      ]),
    ],
    NOW
  );
  assert.deepEqual(
    unexpectedDeployments(
      [
        deployment('production', '2026-11-27T11:51:00Z'),
        deployment('staging', '2026-11-27T11:59:00Z'),
      ],
      spans,
      SINCE
    ),
    []
  );
});

test('a deployment no STS deploy job covers, or not made by wrangler deploy, is reported', () => {
  const spans = deployJobSpans(
    [
      run('.github/workflows/deploy-production.yml', [
        job('deploy-workers / Deploy services/sts', '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z'),
        job(
          'deploy-workers / Deploy services/usage-ingest',
          '2026-11-27T11:30:00Z',
          '2026-11-27T11:32:00Z'
        ),
        job(
          'deploy-workers / Deploy services/sts',
          '2026-11-27T11:20:00Z',
          '2026-11-27T11:22:00Z',
          'skipped'
        ),
      ]),
      run('.github/workflows/ci.yml', [
        job('Deploy services/sts', '2026-11-27T11:10:00Z', '2026-11-27T11:12:00Z'),
      ]),
    ],
    NOW
  );
  const found = unexpectedDeployments(
    [
      deployment('production', '2026-11-27T11:31:00Z', 'during-another-worker'),
      deployment('production', '2026-11-27T11:21:00Z', 'during-skipped-job'),
      deployment('production', '2026-11-27T11:11:00Z', 'from-another-workflow'),
      deployment('production', '2026-11-27T11:55:00Z', 'after-the-margin'),
      deployment('staging', '2026-11-27T11:51:00Z', 'other-environment'),
      deployment('production', '2026-11-27T11:51:00Z', 'rollback-in-span', {
        source: 'dash',
        annotations: { 'workers/triggered_by': 'rollback' },
      }),
      deployment('production', '2026-11-27T11:51:30Z', 'secret-in-span', {
        annotations: { 'workers/triggered_by': 'secret' },
      }),
      deployment('production', '2026-11-27T10:59:00Z', 'before-the-window'),
    ],
    spans,
    SINCE
  );
  assert.deepEqual(
    found.map(item => item.deployment.id),
    [
      'during-another-worker',
      'during-skipped-job',
      'from-another-workflow',
      'after-the-margin',
      'other-environment',
      'rollback-in-span',
      'secret-in-span',
    ]
  );
  assert.match(
    slackPayload({ found, clamped: false, since: SINCE }, 'https://run').text,
    /no STS deploy job made \(7\)/
  );
});

test('a manual Worker deploy of STS covers either environment', () => {
  const spans = deployJobSpans(
    [
      run('.github/workflows/deploy-workers.yml', [
        job('Deploy services/sts', '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z'),
      ]),
    ],
    NOW
  );
  assert.deepEqual(
    unexpectedDeployments([deployment('staging', '2026-11-27T11:51:00Z')], spans, SINCE),
    []
  );
});

test('a queued or waiting job, or a finished one that did not run, gives no span', () => {
  const sts = 'deploy-workers / Deploy services/sts';
  const spansOf = jobs =>
    deployJobSpans([run('.github/workflows/deploy-production.yml', jobs)], NOW);
  assert.deepEqual(spansOf([job(sts, '2026-11-27T11:50:00Z', null, null, 'queued')]), []);
  assert.deepEqual(spansOf([job(sts, '2026-11-27T11:50:00Z', null, null, 'waiting')]), []);
  for (const conclusion of ['cancelled', 'skipped', 'timed_out', 'neutral']) {
    assert.deepEqual(
      spansOf([job(sts, '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z', conclusion)]),
      []
    );
  }
});

test('an in-progress job, and a finished one that succeeded or failed, gives a span', () => {
  const sts = 'deploy-workers / Deploy services/sts';
  const spansOf = jobs =>
    deployJobSpans([run('.github/workflows/deploy-production.yml', jobs)], NOW);
  assert.equal(spansOf([job(sts, '2026-11-27T11:50:00Z', null)]).length, 1);
  assert.equal(
    spansOf([job(sts, '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z', 'success')]).length,
    1
  );
  assert.equal(
    spansOf([job(sts, '2026-11-27T11:50:00Z', '2026-11-27T11:52:00Z', 'failure')]).length,
    1
  );
});

test('Cloudflare text in the alert carries no Slack markup', () => {
  assert.equal(escapeMrkdwn('<!channel> `x` *b* & _i_'), '&lt;!channel&gt; x b &amp; i');
  const found = unexpectedDeployments(
    [deployment('production', '2026-11-27T11:30:00Z', '<https://evil|click>')],
    productionSpans,
    SINCE
  );
  const text = slackPayload({ found, clamped: false, since: SINCE }, 'https://run').blocks[1].text
    .text;
  assert.doesNotMatch(text, /<https:\/\/evil/);
});

test('health is stale after 45 minutes without a successful run, counting from creation at first', () => {
  assert.equal(isStale(NOW, NOW - STALE_AFTER_MS + 1, 0), false);
  assert.equal(isStale(NOW, NOW - STALE_AFTER_MS - 1, 0), true);
  assert.equal(isStale(NOW, null, NOW - 10 * 60_000), false);
  assert.equal(isStale(NOW, null, NOW - STALE_AFTER_MS - 1), true);
});

const ENV = {
  CLOUDFLARE_TOKEN: 'cf',
  GITHUB_TOKEN: 'gh',
  GITHUB_REPOSITORY: 'Kilo-Org/cloud',
  GITHUB_RUN_ID: '9',
};

function stubFetch({
  lastRun = '2026-11-27T11:45:00Z',
  cloudflare = () => ({ success: true, result: { deployments: [] } }),
  cloudflareStatus = 200,
} = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const respond = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    if (url.includes('api.cloudflare.com')) return respond(cloudflareStatus, cloudflare(url));
    if (url.includes('/workflows/sts-deployment-watch.yml/runs')) {
      return respond(200, { workflow_runs: lastRun ? [{ run_started_at: lastRun }] : [] });
    }
    if (url.endsWith('/workflows/sts-deployment-watch.yml'))
      return respond(200, { created_at: '2026-11-20T00:00:00Z' });
    if (url.includes('/runs?created=')) return respond(200, { workflow_runs: [] });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, calls };
}

test('watch reads only main scheduled runs and reports nothing when nothing changed', async () => {
  const { fetchImpl, calls } = stubFetch();
  assert.deepEqual(await watch({ env: ENV, fetch: fetchImpl, now: NOW }), {
    found: '0',
    clamped: 'false',
  });
  assert.ok(calls[0].includes('status=success&branch=main&event=schedule'));
});

test('watch posts an unexpected deployment and a clamped window', async () => {
  const found = await watch({
    env: ENV,
    fetch: stubFetch({
      cloudflare: url =>
        url.includes('/sts/')
          ? {
              success: true,
              result: {
                deployments: [deployment('production', '2026-11-27T11:50:00Z').deployment],
              },
            }
          : { success: true, result: { deployments: [] } },
    }).fetchImpl,
    now: NOW,
  });
  assert.equal(found.found, '1');
  assert.ok(found.payload);
  const clamped = await watch({
    env: ENV,
    fetch: stubFetch({ lastRun: '2026-10-01T00:00:00Z' }).fetchImpl,
    now: NOW,
  });
  assert.equal(clamped.clamped, 'true');
  assert.match(JSON.parse(clamped.payload).blocks[1].text.text, /older than 7 days/);
});

test('watch fails, so the workflow posts the failure, when it cannot check', async () => {
  await assert.rejects(
    watch({
      env: ENV,
      fetch: stubFetch({ cloudflare: () => ({ success: false, errors: [] }) }).fetchImpl,
      now: NOW,
    }),
    /could not be read/
  );
  await assert.rejects(
    watch({ env: ENV, fetch: stubFetch({ cloudflareStatus: 403 }).fetchImpl, now: NOW }),
    /answered 403/
  );
  await assert.rejects(
    watch({ env: { ...ENV, CLOUDFLARE_TOKEN: '' }, fetch: stubFetch().fetchImpl, now: NOW }),
    /CLOUDFLARE_TOKEN is not set/
  );
});

test('health needs no Cloudflare token and reports a stale watch', async () => {
  const env = { GITHUB_TOKEN: 'gh', GITHUB_REPOSITORY: 'Kilo-Org/cloud' };
  assert.deepEqual(await health({ env, fetch: stubFetch().fetchImpl, now: NOW }), {
    stale: 'false',
  });
  assert.deepEqual(
    await health({
      env,
      fetch: stubFetch({ lastRun: '2026-11-27T10:00:00Z' }).fetchImpl,
      now: NOW,
    }),
    { stale: 'true' }
  );
});
