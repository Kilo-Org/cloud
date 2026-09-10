import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

const workflowPath = '.github/workflows/kilo-mcp-catalog.yml';
const testPath = 'scripts/kilo-mcp-catalog.test.mjs';
const prJobName = 'catalog-pr';
const mergeJobName = 'catalog-merge';
const dumpCommand = 'pnpm --filter web script src/scripts/mcp-catalog/dump.ts';
const embedCommand = 'node services/kilo-mcp/scripts/embed-catalog.ts upsert';
const kiloInstallCommand = 'npm install -g @kilocode/cli';
const mergeGate = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const forkCondition = 'github.event.pull_request.head.repo.fork == true';
const sameRepoCondition = 'github.event.pull_request.head.repo.fork == false';
const prPaths = ['apps/web/src/**', 'services/kilo-mcp/**', workflowPath, testPath];

function readWorkflow() {
  return load(readFileSync(new URL(`../${workflowPath}`, import.meta.url), 'utf8'));
}

function stepText(step) {
  return `${step.run ?? ''} ${step.uses ?? ''} ${JSON.stringify(step.with ?? {})}`;
}

function findStep(job, predicate, what) {
  const step = job.steps.find(predicate);
  assert.ok(step, `${job.name ?? 'job'}: ${what} must exist`);
  return step;
}

function validate(workflow) {
  assert.deepEqual(Object.keys(workflow.jobs), [prJobName, mergeJobName], 'exactly two jobs');
  const pr = workflow.jobs[prJobName];
  const merge = workflow.jobs[mergeJobName];

  // Triggers: PRs on the catalog's source paths; pushes on main only.
  assert.equal(pr.if, "github.event_name == 'pull_request'", `${prJobName}: PR-event only`);
  assert.equal(merge.if, mergeGate, `${mergeJobName}: gated to main pushes only (requirement 10)`);
  assert.deepEqual(
    workflow.on.pull_request.paths,
    prPaths,
    'pull_request admits the catalog paths'
  );
  assert.deepEqual(workflow.on.push.branches, ['main'], 'push stays main-only');

  // The PR job runs the real dump script with Kilo CLI credentials so missing
  // summaries get filled (requirement 2), and keeps author edits through the
  // dump's own keep-edit rule (requirement 5).
  const prDump = findStep(pr, step => step.run === dumpCommand, 'PR job runs the real dump script');
  assert.equal(
    prDump.env?.KILO_AUTH_CONTENT,
    '${{ secrets.MCP_CATALOG_KILO_AUTH }}',
    'PR dump exports the Kilo CLI credential from the repo secret'
  );
  assert.equal(
    prDump.env?.KILO_API_KEY,
    '${{ secrets.MCP_CATALOG_KILO_API_KEY }}',
    'PR dump accepts a durable Kilo API key'
  );
  assert.equal(
    prDump.env?.KILO_ORG_ID,
    '${{ secrets.MCP_CATALOG_KILO_ORG_ID }}',
    'PR dump accepts the Kilo org for the API key'
  );
  findStep(
    pr,
    step => step.run === kiloInstallCommand,
    'PR job installs the Kilo CLI the dump shells out to'
  );

  // Fork PRs never receive the Kilo credential (GitHub withholds secrets from
  // fork pull_request events), so a fork that adds a query cannot run the dump
  // at all. Requirement 6 must still fire: the dump is continue-on-error on
  // forks only, and a fork-conditioned follow-up step posts the self-service
  // guidance and fails the job before drift detection could silently pass.
  assert.equal(prDump.id, 'dump', 'PR dump exposes its outcome to later steps');
  assert.equal(
    prDump['continue-on-error'],
    '${{ github.event.pull_request.head.repo.fork == true }}',
    'PR dump tolerates failure only on fork PRs'
  );
  const dumpGuidance = findStep(
    pr,
    step =>
      (step.if ?? '').includes("steps.dump.outcome == 'failure'") &&
      (step.if ?? '').includes(forkCondition),
    'fork dump-failure guidance step'
  );
  assert.match(dumpGuidance.run ?? '', /gh pr comment/, 'guidance posts a PR comment');
  assert.match(dumpGuidance.run ?? '', /exit 1/, 'guidance fails the job');
  assert.match(
    dumpGuidance.env?.COMMENT_BODY ?? '',
    /hand-write a summary[\s\S]*services\/kilo-mcp\/catalog\.json/,
    'guidance names the self-service path in the committed catalog'
  );
  const drift = findStep(pr, step => step.id === 'drift', 'drift detection step');
  assert.ok(
    pr.steps.indexOf(dumpGuidance) < pr.steps.indexOf(drift),
    'dump-failure guidance must run before drift detection, or a failed fork dump could pass silently'
  );

  // PR jobs never touch Vectorize or the embed script (requirement 10).
  for (const step of pr.steps) {
    assert.doesNotMatch(
      stepText(step),
      /embed-catalog|catalog:embed|vectorize|CLOUDFLARE/i,
      `${prJobName}: no PR-triggered step may reference the embed script or Vectorize`
    );
  }

  // Same-repo drift is committed back under the bot identity, catalog.json
  // only (requirement 5).
  const commit = findStep(
    pr,
    step => (step.if ?? '').includes(sameRepoCondition),
    'same-repo commit step'
  );
  assert.match(commit.run, /git add services\/kilo-mcp\/catalog\.json/, 'commit only catalog.json');
  assert.match(commit.run, /github-actions\[bot\]/, 'bot identity on the commit');
  assert.match(commit.run, /git push/, 'the commit is pushed to the PR branch');

  // Fork drift: patch artifact + one-line PR comment + non-zero exit
  // (requirement 6).
  const patch = findStep(
    pr,
    step => (step.if ?? '').includes(forkCondition) && /git diff/.test(step.run ?? ''),
    'fork catalog.patch export step'
  );
  assert.match(patch.run, /catalog\.patch/, 'diff is written to catalog.patch');
  const artifact = findStep(
    pr,
    step => (step.uses ?? '').startsWith('actions/upload-artifact@'),
    'fork patch artifact upload'
  );
  assert.equal(artifact.with.name, 'catalog.patch', 'artifact carries the patch');
  const comment = findStep(
    pr,
    step =>
      (step.if ?? '').includes('steps.drift.outputs.changed') &&
      /gh pr comment/.test(step.run ?? ''),
    'fork PR comment step'
  );
  assert.match(comment.env.COMMENT_BODY, /catalog\.patch/, 'comment points at the patch');
  assert.match(
    comment.env.COMMENT_BODY,
    new RegExp(dumpCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'comment gives the run command'
  );
  const fail = findStep(
    pr,
    step =>
      (step.if ?? '').includes('steps.drift.outputs.changed') && /exit 1/.test(step.run ?? ''),
    'fork job must fail'
  );
  assert.ok(fail, 'fork drift exits non-zero');

  // Merge job: dump fills stragglers (requirement 8), then the embed script
  // upserts Vectorize with the Cloudflare credentials (requirement 9).
  const mergeDump = findStep(merge, step => step.run === dumpCommand, 'merge job runs the dump');
  assert.equal(
    mergeDump.env?.KILO_AUTH_CONTENT,
    '${{ secrets.MCP_CATALOG_KILO_AUTH }}',
    'merge dump exports the Kilo CLI credential'
  );
  assert.equal(
    mergeDump.env?.KILO_API_KEY,
    '${{ secrets.MCP_CATALOG_KILO_API_KEY }}',
    'merge dump accepts a durable Kilo API key'
  );
  findStep(
    merge,
    step => step.run === kiloInstallCommand,
    'merge job installs the Kilo CLI the dump shells out to'
  );
  const upsert = findStep(merge, step => step.run === embedCommand, 'merge job upserts Vectorize');
  assert.equal(
    upsert.env?.CLOUDFLARE_API_TOKEN,
    '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'upsert uses the Cloudflare API token secret'
  );
  assert.ok(upsert.env?.CLOUDFLARE_ACCOUNT_ID, 'upsert gets the Cloudflare account id');
  assert.equal(
    upsert.env.VECTORIZE_INDEX_NAME,
    'kilo-mcp-catalog',
    'upsert targets the prod index'
  );
}

test('workflow file exists', () => {
  assert.ok(
    existsSync(new URL(`../${workflowPath}`, import.meta.url)),
    `${workflowPath} must exist`
  );
});

test('catalog workflow wiring is valid', () => {
  validate(readWorkflow());
});

for (const [name, defect] of [
  [
    'dump step removed',
    workflow => dropStep(workflow, prJobName, step => step.run === dumpCommand),
  ],
  [
    'Kilo CLI install removed from the PR job',
    workflow => dropStep(workflow, prJobName, step => step.run === kiloInstallCommand),
  ],
  [
    'Kilo CLI install removed from the merge job',
    workflow => dropStep(workflow, mergeJobName, step => step.run === kiloInstallCommand),
  ],
  [
    'embed script referenced from a PR step',
    workflow => addStep(workflow, prJobName, { run: embedCommand }),
  ],
  [
    'Vectorize referenced from a PR step',
    workflow => addStep(workflow, prJobName, { run: 'echo VECTORIZE' }),
  ],
  ['merge job ungated', workflow => (workflow.jobs[mergeJobName].if = undefined)],
  [
    'merge job opened to pull_request',
    workflow => (workflow.jobs[mergeJobName].if = "github.event_name == 'pull_request'"),
  ],
  [
    'fork patch artifact removed',
    workflow =>
      dropStep(workflow, prJobName, step =>
        (step.uses ?? '').startsWith('actions/upload-artifact@')
      ),
  ],
  [
    'fork comment removed',
    workflow =>
      dropStep(
        workflow,
        prJobName,
        step =>
          (step.if ?? '').includes('steps.drift.outputs.changed') &&
          /gh pr comment/.test(step.run ?? '')
      ),
  ],
  [
    'fork failure removed',
    workflow =>
      dropStep(
        workflow,
        prJobName,
        step =>
          (step.if ?? '').includes('steps.drift.outputs.changed') && /exit 1/.test(step.run ?? '')
      ),
  ],
  [
    'fork dump-failure guidance removed',
    workflow =>
      dropStep(workflow, prJobName, step =>
        (step.if ?? '').includes("steps.dump.outcome == 'failure'")
      ),
  ],
  [
    'fork dump-failure guidance not fatal',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item =>
        (item.if ?? '').includes("steps.dump.outcome == 'failure'")
      );
      step.run = step.run.replace(/exit 1/, 'exit 0');
    },
  ],
  [
    'fork dump-failure guidance missing the self-service path',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item =>
        (item.if ?? '').includes("steps.dump.outcome == 'failure'")
      );
      step.env.COMMENT_BODY = 'The catalog dump failed on this fork PR.';
    },
  ],
  [
    'fork dump-failure guidance runs after drift detection',
    workflow => {
      const steps = workflow.jobs[prJobName].steps;
      const guidance = steps.find(step =>
        (step.if ?? '').includes("steps.dump.outcome == 'failure'")
      );
      const driftIndex = steps.findIndex(step => step.id === 'drift');
      steps.splice(steps.indexOf(guidance), 1);
      steps.splice(driftIndex + 1, 0, guidance);
    },
  ],
  [
    'dump step fatal on forks too',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.run === dumpCommand);
      delete step['continue-on-error'];
    },
  ],
  [
    'dump step outcome not exposed',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.run === dumpCommand);
      delete step.id;
    },
  ],
  [
    'bot identity stripped from the commit',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item =>
        (item.if ?? '').includes(sameRepoCondition)
      );
      step.run = step.run.replace(/github-actions\[bot\]/g, 'someone');
    },
  ],
  [
    'merge upsert removed',
    workflow => dropStep(workflow, mergeJobName, step => step.run === embedCommand),
  ],
]) {
  test(`wiring check rejects: ${name}`, () => {
    const workflow = readWorkflow();
    defect(workflow);
    assert.throws(() => validate(workflow), assert.AssertionError);
  });
}

function dropStep(workflow, jobName, predicate) {
  const job = workflow.jobs[jobName];
  const index = job.steps.findIndex(predicate);
  assert.ok(index >= 0, `mutation target exists in ${jobName}`);
  job.steps.splice(index, 1);
}

function addStep(workflow, jobName, step) {
  workflow.jobs[jobName].steps.push(step);
}
