import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

import {
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  STS_SCRIPTS,
  WINDOW_OVERLAP_MS,
  deployJobSpans,
  slackPayload,
  unexpectedDeployments,
  windowStart,
} from './sts-deployment-watch.mjs';

const workflow = load(
  readFileSync(new URL('../.github/workflows/sts-deployment-watch.yml', import.meta.url), 'utf8')
);
const stsConfig = readFileSync(new URL('../services/sts/wrangler.jsonc', import.meta.url), 'utf8');

const NOW = Date.parse('2026-11-27T12:00:00Z');
const at = iso => Date.parse(iso);

function run(path, jobs) {
  return { run: { id: 1, path }, jobs };
}

function job(name, started, completed, conclusion = 'success') {
  return {
    name,
    started_at: started,
    completed_at: completed,
    conclusion,
    html_url: `https://x/${name}`,
  };
}

function deployment(environment, created, id = created) {
  return {
    environment,
    script: STS_SCRIPTS[environment],
    deployment: { id, created_on: created, source: 'wrangler', author_email: 'ci@example.invalid' },
  };
}

test('runs on a schedule in the canonical repository with read-only token permissions', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { actions: 'read', contents: 'read' });
  const watch = workflow.jobs.watch;
  assert.equal(watch.if, "github.repository == 'Kilo-Org/cloud'");
  const step = watch.steps.find(item => item.id === 'watch');
  assert.equal(step.run, 'node scripts/sts-deployment-watch.mjs');
  assert.equal(step.env.CLOUDFLARE_TOKEN, '${{ secrets.STS_WATCH_CLOUDFLARE_TOKEN }}');
  assert.equal(watch.steps.at(-1).if, "steps.watch.outputs.found != '0'");
});

test('watches the STS script names that services/sts/wrangler.jsonc deploys', () => {
  assert.match(stsConfig, /^ {2}"name": "sts",$/m);
  assert.match(stsConfig, /"name": "sts-staging",/);
  assert.deepEqual(STS_SCRIPTS, { production: 'sts', staging: 'sts-staging' });
});

test('opens the window at the previous success less the overlap, bounded', () => {
  assert.equal(windowStart(NOW, null), NOW - DEFAULT_WINDOW_MS);
  assert.equal(windowStart(NOW, NOW - 900_000), NOW - 900_000 - WINDOW_OVERLAP_MS);
  assert.equal(windowStart(NOW, NOW - 30 * 24 * 3600_000), NOW - MAX_WINDOW_MS);
});

test('a deployment inside an STS deploy job of its environment is expected', () => {
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
  const since = at('2026-11-27T11:00:00Z');
  assert.deepEqual(
    unexpectedDeployments(
      [
        deployment('production', '2026-11-27T11:51:00Z'),
        deployment('staging', '2026-11-27T11:59:00Z'),
      ],
      spans,
      since
    ),
    []
  );
});

test('a deployment no STS deploy job covers is reported', () => {
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
  const since = at('2026-11-27T11:00:00Z');
  const found = unexpectedDeployments(
    [
      deployment('production', '2026-11-27T11:31:00Z', 'during-another-worker'),
      deployment('production', '2026-11-27T11:21:00Z', 'during-skipped-job'),
      deployment('production', '2026-11-27T11:11:00Z', 'from-another-workflow'),
      deployment('production', '2026-11-27T11:55:00Z', 'after-the-margin'),
      deployment('staging', '2026-11-27T11:51:00Z', 'other-environment'),
      deployment('production', '2026-11-27T10:59:00Z', 'before-the-window'),
    ],
    spans,
    since
  );
  assert.deepEqual(
    found.map(item => item.deployment.id),
    [
      'during-another-worker',
      'during-skipped-job',
      'from-another-workflow',
      'after-the-margin',
      'other-environment',
    ]
  );
  assert.match(slackPayload(found, 'https://run').text, /no STS deploy job made \(5\)/);
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
    unexpectedDeployments(
      [deployment('staging', '2026-11-27T11:51:00Z')],
      spans,
      at('2026-11-27T11:00:00Z')
    ),
    []
  );
});
