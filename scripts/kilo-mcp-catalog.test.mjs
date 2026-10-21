import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

const workflowPath = '.github/workflows/kilo-mcp-catalog.yml';
const testPath = 'scripts/kilo-mcp-catalog.test.mjs';
const prepareJobName = 'catalog-prepare';
const summariesJobName = 'catalog-summaries';
const prJobName = 'catalog-pr';
const mergeJobName = 'catalog-merge';
const dumpApplyCommand =
  'pnpm --filter web script src/scripts/mcp-catalog/dump.ts -- --summaries-file /tmp/catalog-summaries/summary-summaries.json';
const promptsCommand =
  'pnpm --filter web script src/scripts/mcp-catalog/prompts.ts -- /tmp/catalog-prompts/summary-prompts.json';
const completeCommand =
  'node /tmp/catalog-complete.cjs /tmp/catalog-prompts/summary-prompts.json /tmp/catalog-summaries/summary-summaries.json';
const skillCommand = 'pnpm --filter web script src/scripts/mcp-catalog/skill.ts';
const skillPath = '.kilo/skills/kilo-mcp/SKILL.md';
const embedCommand = 'node services/kilo-mcp/scripts/embed-catalog.ts upsert';
const kiloInstallCommand = 'npm install -g @kilocode/cli';
const mintCommand = 'api/internal/mcp-catalog/token';
const mintSecretEnv = '${{ secrets.MCP_CATALOG_TOKEN_SECRET }}';
const mergeGate = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const forkCondition = 'github.event.pull_request.head.repo.fork == true';
const sameRepoCondition = 'github.event.pull_request.head.repo.fork == false';
const prepareChangeGate = "steps.catalog_changes.outputs.catalog == 'true'";
const mergeChangeGate = "steps.merge_changes.outputs.catalog == 'true'";
// The paths the change-detection steps must recognise. The workflow-path
// entries tolerate the grep escaping (`\.yml`, `\.test\.mjs`) so the required
// check keeps running the pipeline whenever the catalog can actually change,
// and the skill entry keeps `.kilo/skills/kilo-mcp/SKILL.md` inside the
// detected set so a hand-edited skill re-runs the pipeline.
const catalogPathFragments = [
  /apps\/web\/src\//,
  /services\/kilo-mcp\//,
  /kilo-mcp\/SKILL|\.kilo\/skills\//,
  /kilo-mcp-catalog\\?\.yml/,
  /kilo-mcp-catalog\\?\.test\\?\.mjs/,
];
// A `git diff --exit-code` that covers both committed artifacts in the order
// the workflow writes them (catalog first, then the generated skill), so
// dropping either path from the drift command fails the check.
const driftDiffCommand = new RegExp(
  `git diff --exit-code -- services/kilo-mcp/catalog\\.json ${skillPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
);

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

/**
 * The credential declaration invariant: the completion steps receive
 * KILO_API_KEY/KILO_ORG_ID from the mint step outputs, and the credential is
 * declared as step-level env of those two steps alone.
 */
function assertCredentialConfinement(workflow, completeByJob) {
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    // Job-level env applies to every step, so the credential is declared on
    // the completion step instead.
    assert.deepEqual(
      Object.keys(job.env ?? {}).filter(
        key => key === 'KILO_API_KEY' || key === 'KILO_ORG_ID' || key === 'KILO_CONFIG_CONTENT'
      ),
      [],
      `${jobName}: the credential env and the completion config are declared on the completion step`
    );
    for (const step of job.steps) {
      const text = `${step.run ?? ''} ${JSON.stringify(step.env ?? {})}`;
      assert.doesNotMatch(
        text,
        /GITHUB_ENV[\s\S]{0,200}(KILO_API_KEY|KILO_CONFIG_CONTENT)|(KILO_API_KEY|KILO_CONFIG_CONTENT)[\s\S]{0,200}GITHUB_ENV/,
        `${jobName}/${step.name ?? step.uses}: the completion env is declared on the completion step`
      );
      const envKeys = Object.keys(step.env ?? {});
      const runConfig = envKeys.filter(key => key === 'KILO_CONFIG_CONTENT');
      const expectedConfig = completeByJob.get(jobName) === step ? runConfig : [];
      assert.deepEqual(
        runConfig.filter(key => !expectedConfig.includes(key)),
        [],
        `${jobName}/${step.name ?? step.uses}: only the completion step declares the completion config`
      );
      const tokenEnv = envKeys.filter(key => key === 'KILO_API_KEY' || key === 'KILO_ORG_ID');
      const expected = completeByJob.get(jobName) === step ? tokenEnv : [];
      assert.deepEqual(
        tokenEnv.filter(key => !expected.includes(key)),
        [],
        `${jobName}/${step.name ?? step.uses}: only the completion step declares the credential env`
      );
    }
  }
  for (const [jobName, complete] of completeByJob) {
    assert.equal(complete.env?.KILO_API_KEY, '${{ steps.mint.outputs.token }}');
    assert.equal(complete.env?.KILO_ORG_ID, '${{ steps.mint.outputs.organization }}');
    // The completion receives rendered prompt text, so it runs with every
    // tool permission denied and only returns text.
    assert.equal(
      complete.env?.KILO_CONFIG_CONTENT,
      JSON.stringify({ permission: { '*': 'deny' } }),
      `${jobName}: the completion step runs with every tool permission denied`
    );
    // Every completion job mints its own token right before completing.
    const mint = findStep(workflow.jobs[jobName], step => step.id === 'mint', 'mint step');
    assert.equal(mint.env?.MCP_CATALOG_TOKEN_SECRET, mintSecretEnv);
    assert.match(mint.run ?? '', new RegExp(mintCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const steps = workflow.jobs[jobName].steps;
    assert.ok(
      steps.indexOf(mint) < steps.indexOf(complete),
      `${jobName}: the completion step must run after the mint`
    );
  }
}

/**
 * Change detection must match a written name list. Piping `git diff` into
 * `grep -q` lets grep exit on its first match; git then takes SIGPIPE and
 * `pipefail` reports the pipeline as a failure, which reads as "no changes"
 * and silently skips the pipeline.
 */
function assertNoPipedDiff(step, jobName) {
  assert.doesNotMatch(
    step.run ?? '',
    // A pipe may sit on the same line or on a `\`-continued next line.
    /git diff --name-only[\s\S]{0,160}?\|\s*grep/,
    `${jobName}: change detection matches a written name list, not a piped diff`
  );
  assert.match(
    step.run ?? '',
    />\s*"\$changed"/,
    `${jobName}: change detection writes the name list before matching it`
  );
}

function validate(workflow) {
  assert.deepEqual(
    Object.keys(workflow.jobs),
    [prepareJobName, summariesJobName, prJobName, mergeJobName],
    'exactly four jobs: prepare, trusted summaries, required PR check, merge'
  );
  const prepare = workflow.jobs[prepareJobName];
  const summaries = workflow.jobs[summariesJobName];
  const pr = workflow.jobs[prJobName];
  const merge = workflow.jobs[mergeJobName];

  // Triggers: PRs on every branch head (the check is required and must always
  // report); pushes on main only.
  assert.equal(
    prepare.if,
    "github.event_name == 'pull_request'",
    `${prepareJobName}: PR-event only`
  );
  assert.equal(pr.if, "${{ github.event_name == 'pull_request' && !cancelled() }}");
  assert.equal(merge.if, mergeGate, `${mergeJobName}: gated to main pushes only (requirement 10)`);
  assert.ok(
    !workflow.on.pull_request?.paths,
    'pull_request must not filter by path: a skipped required check blocks unrelated PRs'
  );
  assert.deepEqual(workflow.on.push.branches, ['main'], 'push stays main-only');
  assert.equal(
    workflow.on.push.paths,
    undefined,
    'push must not filter by path: the merge job is required on main and must always report'
  );

  // Job graph: prepare → summaries → required check; the check still reports
  // when an upstream job was skipped (unrelated PR) or failed (fatal, and the
  // check itself names the failure instead of reporting green).
  assert.deepEqual(summaries.needs, prepareJobName, 'the trusted job depends on prepare');
  assert.deepEqual(pr.needs, [prepareJobName, summariesJobName]);
  assert.match(
    pr.if,
    /!cancelled\(\)/,
    'the required check must report even when an upstream job was skipped or failed'
  );
  const upstreamFail = findStep(
    pr,
    step => (step.if ?? '').includes("needs.catalog-prepare.result != 'success'"),
    'the required check must fail loudly when an upstream job failed'
  );
  assert.match(upstreamFail.run ?? '', /exit 1/);

  // The prepare job enumerates the PR checkout and writes the prompt
  // artifact; the PR checkout code in this job never sees a credential.
  const gate = findStep(prepare, step => step.id === 'catalog_changes', 'change-detection step');
  for (const fragment of catalogPathFragments) {
    assert.match(gate.run ?? '', fragment, `change-detection step must recognise ${fragment}`);
  }
  assertNoPipedDiff(gate, prepareJobName);
  const gateIndex = prepare.steps.indexOf(gate);
  for (const step of prepare.steps.slice(gateIndex + 1)) {
    assert.match(
      step.if ?? '',
      new RegExp(prepareChangeGate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${step.name ?? step.uses}: every post-detection step must be gated on catalog-relevant changes`
    );
  }
  const prompts = findStep(
    prepare,
    step => (step.run ?? '').includes(promptsCommand),
    'prompt writer'
  );
  findStep(
    prepare,
    step => (step.uses ?? '').startsWith('actions/upload-artifact@'),
    'prompt artifact upload'
  );
  assert.ok(
    prepare.steps.indexOf(prompts) > gateIndex,
    'prompt writing runs after change detection'
  );
  // No step in the prepare job may mint or reference the credential.
  for (const step of prepare.steps) {
    assert.doesNotMatch(
      JSON.stringify(step.env ?? {}),
      /MCP_CATALOG_TOKEN_SECRET|KILO_API_KEY/,
      `${prepareJobName}/${step.name}: no PR-checkout step may receive the catalog credential`
    );
  }

  // The trusted job: no checkout, artifact in, summaries out, credential only
  // on the completion step.
  assert.ok(
    !summaries.steps.some(step => (step.uses ?? '').includes('checkout')),
    `${summariesJobName}: the trusted job must not check out any repository code`
  );
  const trustedComplete = findStep(
    summaries,
    step => step.run === completeCommand,
    'trusted completion step'
  );
  findStep(
    summaries,
    step => (step.uses ?? '').startsWith('actions/download-artifact@'),
    'prompt artifact download'
  );
  findStep(
    summaries,
    step => step.run === kiloInstallCommand,
    'the trusted job installs the Kilo CLI the completion shells out to'
  );
  assert.equal(
    trustedComplete['continue-on-error'],
    '${{ github.event.pull_request.head.repo.fork == true }}',
    'the trusted completion tolerates failure only on fork PRs'
  );
  // A failed completion still yields an (empty) summaries artifact, so the
  // required check's apply step fails on uncovered paths instead of missing
  // the file.
  const fallback = findStep(
    summaries,
    step => (step.if ?? '').includes("steps.complete.outcome != 'success'"),
    'empty-summaries fallback step'
  );
  assert.match(fallback.run ?? '', /summary-summaries\.json/);
  const upload = findStep(
    summaries,
    step => (step.uses ?? '').startsWith('actions/upload-artifact@'),
    'summaries artifact upload'
  );
  assert.equal(upload.if, 'always()', 'the summaries artifact uploads even after a failure');
  assert.equal(upload.with.name, 'catalog-summaries');

  // The required check applies the trusted summaries with the dump's
  // --summaries-file path (the CLI runs only in its own job), regenerates
  // the skill from the refreshed catalog, and fails on uncovered paths.
  const prDump = findStep(
    pr,
    step => (step.run ?? '').includes('--summaries-file'),
    'PR apply step'
  );
  assert.match(
    prDump.run ?? '',
    new RegExp(dumpApplyCommand.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  assert.equal(prDump.id, 'dump', 'PR apply exposes its outcome to later steps');
  assert.equal(
    prDump['continue-on-error'],
    '${{ github.event.pull_request.head.repo.fork == true }}',
    'PR apply tolerates failure only on fork PRs'
  );
  const prSkill = findStep(
    pr,
    step => step.run === skillCommand,
    'PR job regenerates the kilo-mcp skill'
  );
  assert.ok(
    pr.steps.indexOf(prDump) < pr.steps.indexOf(prSkill),
    'PR skill regeneration must run after the apply, so it reads the refreshed catalog.json'
  );
  assert.doesNotMatch(
    JSON.stringify(prDump.env ?? {}),
    /MCP_CATALOG_KILO_AUTH|KILO_AUTH_CONTENT/,
    'PR apply must not use the personal CLI credential'
  );
  // The required check must not install the Kilo CLI: the apply path never
  // shells out to it, so a CLI here would only invite PR-side completions.
  assert.ok(
    !pr.steps.some(step => step.run === kiloInstallCommand),
    `${prJobName}: no Kilo CLI install in the required check (completions run in the trusted job)`
  );

  // Fork PRs never receive the mint secret (GitHub withholds secrets from
  // fork pull_request events), so a fork that adds a query cannot apply
  // generated summaries. Requirement 6 must still fire: the apply is
  // continue-on-error on forks only, and a fork-conditioned follow-up step
  // posts the self-service guidance and fails the job before drift detection
  // could silently pass.
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
    'dump-failure guidance must run before drift detection, or a failed fork apply could pass silently'
  );
  assert.match(
    drift.run ?? '',
    /git diff --exit-code/,
    'PR drift detection diffs the committed artifacts'
  );
  assert.match(
    drift.run ?? '',
    driftDiffCommand,
    'PR drift detection must also diff the generated skill, so a hand edit marks the PR stale'
  );

  // PR jobs never touch Vectorize or the embed script (requirement 10).
  for (const job of [prepare, summaries, pr]) {
    for (const step of job.steps) {
      assert.doesNotMatch(
        stepText(step),
        /embed-catalog|catalog:embed|vectorize|CLOUDFLARE/i,
        `${job.name}: no PR-triggered step may reference the embed script or Vectorize`
      );
    }
  }

  // Same-repo drift is committed back under the bot identity: the catalog and
  // the generated skill (requirement 5).
  const commit = findStep(
    pr,
    step => (step.if ?? '').includes(sameRepoCondition),
    'same-repo commit step'
  );
  assert.match(commit.run, /git add services\/kilo-mcp\/catalog\.json/, 'commit the catalog.json');
  assert.ok(commit.run.includes(skillPath), 'commit-back must include the generated skill');
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
  assert.ok(patch.run.includes(skillPath), 'fork patch export must include the generated skill');
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
    /pnpm --filter web script src\/scripts\/mcp-catalog\/dump\.ts/,
    'comment gives the run command'
  );
  const fail = findStep(
    pr,
    step =>
      (step.if ?? '').includes('steps.drift.outputs.changed') && /exit 1/.test(step.run ?? ''),
    'fork job must fail'
  );
  assert.ok(fail, 'fork drift exits non-zero');

  // Credential scoping across the whole workflow: token only on the two
  // completion steps (trusted job + merge job), sourced from mint outputs.
  const mergeComplete = findStep(
    merge,
    step => step.run === completeCommand,
    'merge completion step'
  );
  assertCredentialConfinement(
    workflow,
    new Map([
      [summariesJobName, trustedComplete],
      [mergeJobName, mergeComplete],
    ])
  );

  // The merge job runs on every main push but gates the pipeline and the
  // upsert on the same catalog paths, so an unrelated main push stays cheap
  // (requirement 9/22) without leaving the required check "Expected".
  const mergeDetect = findStep(
    merge,
    step => step.id === 'merge_changes',
    'merge change-detection step'
  );
  for (const fragment of catalogPathFragments) {
    assert.match(
      mergeDetect.run ?? '',
      fragment,
      `merge change-detection step must recognise ${fragment}`
    );
  }
  assertNoPipedDiff(mergeDetect, mergeJobName);
  const mergeGateIndex = merge.steps.indexOf(mergeDetect);
  for (const step of merge.steps.slice(mergeGateIndex + 1)) {
    assert.match(
      step.if ?? '',
      new RegExp(mergeChangeGate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${step.name ?? step.uses}: every post-detection step in the merge job must be gated on catalog-relevant changes`
    );
  }

  // Merge job: prompts on the trusted main checkout, completion fills
  // stragglers (requirement 8), the skill is regenerated from it, then the
  // embed script upserts Vectorize with the Cloudflare credentials
  // (requirement 9).
  const mergePrompts = findStep(
    merge,
    step => (step.run ?? '').includes(promptsCommand),
    'merge prompt writer'
  );
  assert.equal(mergePrompts.if, mergeChangeGate);
  const mergeDump = findStep(
    merge,
    step => (step.run ?? '').includes('--summaries-file'),
    'merge apply step'
  );
  assert.equal(mergeDump.if, mergeChangeGate);
  findStep(
    merge,
    step => step.run === kiloInstallCommand,
    'merge job installs the Kilo CLI the completion shells out to'
  );
  const mergeSkill = findStep(
    merge,
    step => step.run === skillCommand,
    'merge job regenerates the kilo-mcp skill'
  );
  assert.equal(
    mergeSkill.if,
    mergeChangeGate,
    'merge skill regeneration is gated on catalog-relevant changes'
  );
  const upsert = findStep(merge, step => step.run === embedCommand, 'merge job upserts Vectorize');
  const mergeDrift = findStep(
    merge,
    step => /git diff --exit-code[\s\S]*services\/kilo-mcp\/catalog\.json/.test(step.run ?? ''),
    'merge job fails when the regenerated catalog is not the committed one'
  );
  assert.ok(
    merge.steps.indexOf(mergeDump) < merge.steps.indexOf(mergeDrift) &&
      merge.steps.indexOf(mergeDrift) < merge.steps.indexOf(upsert),
    'the merge drift check must run between the apply and the Vectorize upsert'
  );
  assert.ok(
    merge.steps.indexOf(mergePrompts) < merge.steps.indexOf(mergeComplete) &&
      merge.steps.indexOf(mergeComplete) < merge.steps.indexOf(mergeDump),
    'the merge pipeline must run prompts → complete → apply in order'
  );
  assert.ok(
    merge.steps.indexOf(mergeDump) < merge.steps.indexOf(mergeSkill) &&
      merge.steps.indexOf(mergeSkill) < merge.steps.indexOf(mergeDrift),
    'the merge skill must be regenerated after the apply and before the stale check'
  );
  assert.match(
    mergeDrift.run ?? '',
    driftDiffCommand,
    'merge stale check must cover the generated skill, not only the catalog'
  );
  assert.match(
    mergeDrift.run ?? '',
    /exit 1/,
    'a catalog changed on main must fail the merge job, not index the stale bundled catalog'
  );
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
    'apply step removed from the required check',
    workflow =>
      dropStep(workflow, prJobName, step => (step.run ?? '').includes('--summaries-file')),
  ],
  [
    'prompt writer removed from the prepare job',
    workflow =>
      dropStep(workflow, prepareJobName, step => (step.run ?? '').includes(promptsCommand)),
  ],
  [
    'trusted checkout introduced',
    workflow => {
      workflow.jobs[summariesJobName].steps.unshift({
        name: 'Checkout',
        uses: 'actions/checkout@v4',
      });
    },
  ],
  [
    'prepare job declares the credential env',
    workflow => {
      workflow.jobs[prepareJobName].steps.push({
        name: 'Mint',
        id: 'mint',
        env: { MCP_CATALOG_TOKEN_SECRET: mintSecretEnv },
        run: `curl ${mintCommand}`,
      });
    },
  ],
  [
    'a job-level env block declares the credential',
    workflow => {
      workflow.jobs[summariesJobName].env = {
        KILO_API_KEY: '${{ steps.mint.outputs.token }}',
      };
    },
  ],
  [
    'mint exports the token through the job environment',
    workflow => {
      const step = workflow.jobs[summariesJobName].steps.find(item => item.id === 'mint');
      step.run += '\n          echo "KILO_API_KEY=example" >> "$GITHUB_ENV"';
    },
  ],
  [
    'completion step loses the token env',
    workflow => {
      const step = workflow.jobs[summariesJobName].steps.find(item => item.run === completeCommand);
      delete step.env.KILO_API_KEY;
    },
  ],
  [
    'completion step loses the denied tool permissions',
    workflow => {
      const step = workflow.jobs[summariesJobName].steps.find(item => item.run === completeCommand);
      delete step.env.KILO_CONFIG_CONTENT;
    },
  ],
  [
    'merge completion step allows tools again',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.run === completeCommand);
      step.env.KILO_CONFIG_CONTENT = JSON.stringify({ permission: { '*': 'allow' } });
    },
  ],
  [
    'completion config exported through the job environment',
    workflow => {
      const step = workflow.jobs[summariesJobName].steps.find(item => item.id === 'mint');
      step.run += `\n          echo 'KILO_CONFIG_CONTENT={"permission":{"*":"deny"}}' >> "$GITHUB_ENV"`;
    },
  ],
  [
    'an unrelated step references the token',
    workflow => {
      const step = workflow.jobs[summariesJobName].steps.find(item =>
        (item.uses ?? '').startsWith('actions/upload-artifact@')
      );
      step.env = { KILO_API_KEY: '${{ steps.mint.outputs.token }}' };
    },
  ],
  [
    'fork apply made fatal',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.id === 'dump');
      delete step['continue-on-error'];
    },
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
    'upstream-failure gate removed from the required check',
    workflow =>
      dropStep(workflow, prJobName, step =>
        (step.if ?? '').includes("needs.catalog-prepare.result != 'success'")
      ),
  ],
  [
    'Kilo CLI install added to the required check',
    workflow => {
      workflow.jobs[prJobName].steps.push({
        name: 'Install Kilo CLI',
        run: kiloInstallCommand,
      });
    },
  ],
  [
    'Kilo CLI install removed from the trusted job',
    workflow => dropStep(workflow, summariesJobName, step => step.run === kiloInstallCommand),
  ],
  [
    'Kilo CLI install removed from the merge job',
    workflow => dropStep(workflow, mergeJobName, step => step.run === kiloInstallCommand),
  ],
  [
    'summaries artifact upload removed',
    workflow =>
      dropStep(workflow, summariesJobName, step =>
        (step.uses ?? '').startsWith('actions/upload-artifact@')
      ),
  ],
  [
    'empty-summaries fallback removed',
    workflow =>
      dropStep(workflow, summariesJobName, step =>
        (step.if ?? '').includes("steps.complete.outcome != 'success'")
      ),
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
  [
    'merge drift check removed',
    workflow =>
      dropStep(workflow, mergeJobName, step =>
        /git diff --exit-code[\s\S]*services\/kilo-mcp\/catalog\.json/.test(step.run ?? '')
      ),
  ],
  [
    'merge mint secret changed',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.id === 'mint');
      step.env.MCP_CATALOG_TOKEN_SECRET = '${{ secrets.SOMETHING_ELSE }}';
    },
  ],
  [
    'change-detection gate removed',
    workflow => dropStep(workflow, prepareJobName, step => step.id === 'catalog_changes'),
  ],
  [
    'change detection pipes the name list into grep',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace(
        'git diff --name-only "$base" HEAD > "$changed"',
        'git diff --name-only "$base" HEAD | grep -Ev \'^$\' > "$changed"'
      );
    },
  ],
  [
    'change detection pipes the name list into grep on a continued line',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace(
        'git diff --name-only "$base" HEAD > "$changed"',
        'git diff --name-only "$base" HEAD \\\n            | grep -Ev \'^$\' > "$changed"'
      );
    },
  ],
  [
    'merge change detection matches a piped diff',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.id === 'merge_changes');
      step.run = step.run.replace(
        'git diff --name-only "$before" HEAD > "$changed"',
        'git diff --name-only "$before" HEAD | grep -Ev \'^$\' > "$changed"'
      );
    },
  ],
  [
    'change-detection drops a catalog path',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace('^services/kilo-mcp/', '^services/other/');
    },
  ],
  ['push paths filter added', workflow => (workflow.on.push.paths = ['apps/web/src/**'])],
  [
    'merge change-detection step removed',
    workflow => dropStep(workflow, mergeJobName, step => step.id === 'merge_changes'),
  ],
  [
    'merge prompt step escapes the gate',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item =>
        (item.run ?? '').includes(promptsCommand)
      );
      delete step.if;
    },
  ],
  [
    'merge apply step escapes the gate',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item =>
        (item.run ?? '').includes('--summaries-file')
      );
      delete step.if;
    },
  ],
  [
    'skill regeneration removed from the PR job',
    workflow => dropStep(workflow, prJobName, step => step.run === skillCommand),
  ],
  [
    'skill regeneration removed from the merge job',
    workflow => dropStep(workflow, mergeJobName, step => step.run === skillCommand),
  ],
  [
    'skill path dropped from the prepare change detection',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace('^\\.kilo/skills/', '^\\.kilo/other/');
    },
  ],
  [
    'skill path dropped from the merge change detection',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.id === 'merge_changes');
      step.run = step.run.replace('^\\.kilo/skills/', '^\\.kilo/other/');
    },
  ],
  [
    'skill dropped from PR drift detection',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.id === 'drift');
      step.run = step.run.replace(` ${skillPath}`, '');
    },
  ],
  [
    'skill dropped from the commit-back',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item =>
        (item.if ?? '').includes(sameRepoCondition)
      );
      step.run = step.run.replaceAll(skillPath, 'services/kilo-mcp/catalog.json');
    },
  ],
  [
    'skill dropped from the fork patch export',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(
        item => (item.if ?? '').includes(forkCondition) && /git diff/.test(item.run ?? '')
      );
      step.run = step.run.replace(` ${skillPath}`, '');
    },
  ],
  [
    'skill dropped from the merge stale check',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item =>
        /git diff --exit-code[\s\S]*services\/kilo-mcp\/catalog\.json/.test(item.run ?? '')
      );
      step.run = step.run.replace(` ${skillPath}`, '');
    },
  ],
  [
    'skill step moved before the apply',
    workflow => {
      const steps = workflow.jobs[prJobName].steps;
      const skill = steps.find(step => step.run === skillCommand);
      const dumpIndex = steps.findIndex(step => (step.run ?? '').includes('--summaries-file'));
      steps.splice(steps.indexOf(skill), 1);
      steps.splice(dumpIndex, 0, skill);
    },
  ],
  [
    'required check no longer reports when cancelled',
    workflow => {
      workflow.jobs[prJobName].if = "github.event_name == 'pull_request'";
    },
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
