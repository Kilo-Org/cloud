// Structural rules of .github/workflows/cloud-agent-e2e.yml, the one job that
// runs package code with an STS bundle: services/cloud-agent-next/test/e2e/deploy/README.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load, dump } from 'js-yaml';

const workflow = load(
  readFileSync(new URL('../.github/workflows/cloud-agent-e2e.yml', import.meta.url), 'utf8')
);
const jobs = workflow.jobs;
const GUARD = "github.repository == 'Kilo-Org/cloud' && github.ref == 'refs/heads/main'";

test('runs only on manual dispatch, never as a reusable or scheduled workflow', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
});

test('every job carries the repository and ref guard', () => {
  for (const [name, job] of Object.entries(jobs)) {
    assert.ok(String(job.if ?? '').includes(GUARD), `${name} lacks the guard`);
  }
});

test('only the tests job holds id-token: write', () => {
  for (const [name, job] of Object.entries(jobs)) {
    const idToken = job.permissions?.['id-token'];
    if (name === 'tests') assert.equal(idToken, 'write');
    else assert.notEqual(idToken, 'write', `${name} must not hold id-token`);
  }
  assert.equal(workflow.permissions?.['id-token'], undefined);
});

test('build installs without lifecycle scripts', () => {
  const runs = jobs.build.steps.map(step => step.run ?? '').join('\n');
  assert.match(runs, /pnpm install --frozen-lockfile --ignore-scripts /);
});

test('tests runs no package manager and references no Cloudflare credential', () => {
  for (const step of jobs.tests.steps) {
    assert.doesNotMatch(step.run ?? '', /\bpnpm\b|\bnpm\b|\bnpx\b/, step.name);
  }
  assert.doesNotMatch(dump(jobs.tests), /CLOUDFLARE_/);
});

test('the Cloudflare credential is read only by deploy and preflight', () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (dump(job).includes('secrets.CLOUDFLARE_API_TOKEN')) {
      assert.ok(['deploy', 'preflight'].includes(name), `${name} reads CLOUDFLARE_API_TOKEN`);
    }
  }
  assert.deepEqual(jobs.tests.needs, ['deploy', 'build', 'preflight']);
});

test('every wrangler caller turns Wrangler log files off', () => {
  assert.equal(jobs.deploy.env?.WRANGLER_WRITE_LOGS, 'false');
  for (const script of ['deploy-e2e-worker.sh', 'deploy-fake-llm.sh', 'upload-access-secrets.sh']) {
    const text = readFileSync(
      new URL(`../services/cloud-agent-next/test/e2e/deploy/${script}`, import.meta.url),
      'utf8'
    );
    assert.match(text, /^export WRANGLER_WRITE_LOGS=false$/m, script);
  }
});
