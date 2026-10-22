import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

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
  // Router sources read zod schemas by relative path from cloud-agent-next and
  // by package name from the workspaces below, so a schema-only change there
  // alters catalog.json (inputSchema, tags, searchBlob) without touching
  // apps/web. The derived test below keeps this list honest.
  /services\/cloud-agent-next\/src\/shared\//,
  /packages\/\(app-shared\|cloud-agent-profile\|cloud-agent-sdk\|kiloclaw-instance-tiers\|kiloclaw-secret-catalog\|organization-entitlement\|session-ingest-contracts\)\/src\//,
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
 * Change detection must fail when the diff itself fails, and must judge the
 * pipeline by the matcher: `grep -E` stops at its first match, so `pipefail`
 * would otherwise report a matching pipeline as a failure.
 */
function assertMatcherVerdict(step, jobName) {
  const run = step.run ?? '';
  assert.match(
    run,
    /if ! git diff --name-only \"[^\"]+\" HEAD > \"\$changed\"; then/,
    `${jobName}: change detection writes the name list from the diff`
  );
  assert.match(
    run,
    /if set \+o pipefail && cat \"\$changed\"/,
    `${jobName}: change detection reads a closed pipe as the matcher's answer`
  );
  assert.match(
    run,
    /\n\s*set -o pipefail\n/,
    `${jobName}: change detection restores the step's shell options`
  );
  assert.match(run, /rm -f \"\$changed\"/, `${jobName}: change detection removes its name list`);
}

/** The `grep -Eq '…'` pattern a change-detection step runs. */
function detectionPattern(step, jobName) {
  const match = /grep -Eq '([^']+)'/.exec(step.run ?? '');
  assert.ok(match, `${jobName}: the change-detection step must grep the changed paths with -Eq`);
  return match[1];
}

/**
 * Compiles a `dorny/paths-filter` entry (`**` across directories, `*` within
 * one) into a matcher for a repo-relative path.
 */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // One pass: a `**` replaced first would leave a `*` behind for the single
  // star rule to eat.
  const body = escaped.replace(/\*\*\/|\*\*|\*/g, token =>
    token === '**/' ? '(?:.*/)?' : token === '**' ? '.*' : '[^/]*'
  );
  return new RegExp(`^${body}$`);
}

/** Every workspace directory and its package name, per pnpm-workspace.yaml. */
function workspaceInventory() {
  const config = load(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));
  const dirs = new Set();
  const expand = (prefix, tokens) => {
    if (tokens.length === 0) {
      if (existsSync(prefix)) dirs.add(relative(repoRoot, prefix));
      return;
    }
    const [head, ...rest] = tokens;
    if (head !== '*') {
      expand(join(prefix, head), rest);
      return;
    }
    for (const entry of readdirSync(prefix, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      expand(join(prefix, entry.name), rest);
    }
  };
  for (const glob of config.packages ?? []) expand(repoRoot, glob.split('/'));

  const byName = new Map();
  for (const dir of dirs) {
    const manifest = join(repoRoot, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
    if (typeof name === 'string') byName.set(name, dir);
  }
  return { dirs: [...dirs].sort(), byName };
}

/** The non-test sources the dump imports: the tRPC routers and the dump itself. */
function catalogSourceFiles() {
  const roots = ['apps/web/src/routers', 'apps/web/src/scripts/mcp-catalog'];
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path);
        continue;
      }
      if (/\.(?:ts|tsx|mts)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of roots) walk(join(repoRoot, root));
  return files;
}

/**
 * The file a specifier reads, or null for anything outside the workspace
 * (a third-party package). A bare `@kilocode/<pkg>[/sub]` resolves to that
 * workspace's `src/`, which is the directory a change has to touch.
 */
function resolveSpecifier(specifier, fromFile, byName) {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier);
    const candidates = [`${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, 'index.ts')];
    const found = candidates.find(
      candidate => existsSync(candidate) && statSync(candidate).isFile()
    );
    return found ?? (existsSync(base) ? base : null);
  }
  const [scope, name] = specifier.split('/');
  if (!scope?.startsWith('@') || !name) return null;
  const dir = byName.get(`${scope}/${name}`);
  return dir ? join(repoRoot, dir, 'src', 'index.ts') : null;
}

/**
 * The `kilocode_backend` filter of ci.yml. A change that matches it runs
 * `web-test`, whose `apps/web/src/scripts/mcp-catalog/catalog.test.ts` re-dumps
 * the catalog and fails when the committed artifact is stale — so the author
 * regenerates it and the merge job then sees `services/kilo-mcp/`.
 */
function webTestFilterPaths() {
  const ci = load(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  const step = (ci.jobs?.changes?.steps ?? []).find(
    candidate => typeof candidate.with?.filters === 'string'
  );
  assert.ok(step, 'ci.yml: the changes job must carry its filters inline');
  const filters = load(step.with.filters);
  assert.ok(
    Array.isArray(filters.kilocode_backend),
    'ci.yml: kilocode_backend must be a path list'
  );
  return filters.kilocode_backend;
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
  assertMatcherVerdict(gate, prepareJobName);
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
  // Every job that runs the dump installs the same workspace scope, so the
  // catalog it writes resolves the schemas it reads the same way.
  const dumpInstall = findStep(
    pr,
    step => /pnpm install .*--filter web/.test(step.run ?? ''),
    'PR dependency install'
  );
  assert.match(
    dumpInstall.run ?? '',
    /--filter cloud-agent-next$/,
    `${prJobName}: the dump job installs the schemas it imports`
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
  assertMatcherVerdict(mergeDetect, mergeJobName);
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

/**
 * Paths a catalog source reads that neither the catalog job's detection pattern
 * nor `web-test`'s `kilocode_backend` filter covers. Empty is the invariant:
 * a change there changes `catalog.json` on main with no regenerate and no
 * Vectorize upsert.
 */
function uncoveredCatalogInputs(workflow) {
  const pr = findStep(
    workflow.jobs[prepareJobName],
    step => step.id === 'catalog_changes',
    'PR change-detection step'
  );
  const mergeStep = findStep(
    workflow.jobs[mergeJobName],
    step => step.id === 'merge_changes',
    'merge change-detection step'
  );
  const prPattern = detectionPattern(pr, prepareJobName);
  assert.equal(
    detectionPattern(mergeStep, mergeJobName),
    prPattern,
    'the PR and merge change-detection patterns must stay identical'
  );

  const catalogPaths = new RegExp(prPattern);
  const webTestPaths = webTestFilterPaths().map(globToRegExp);
  const { byName } = workspaceInventory();

  const uncovered = new Set();
  for (const file of catalogSourceFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
      const target = resolveSpecifier(match[1], file, byName);
      if (!target) continue;
      const path = relative(repoRoot, target);
      if (catalogPaths.test(path)) continue;
      if (webTestPaths.some(pattern => pattern.test(path))) continue;
      uncovered.add(`${path} (read by ${relative(repoRoot, file)})`);
    }
  }
  return [...uncovered].sort();
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

test('change detection covers every workspace a catalog source reads', () => {
  assert.deepEqual(
    uncoveredCatalogInputs(readWorkflow()),
    [],
    'add the workspace to both change-detection patterns in kilo-mcp-catalog.yml: a schema change there alters catalog.json on main with no regenerate and no Vectorize upsert'
  );
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
    'change detection drops its matcher verdict',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace('if set +o pipefail && cat', 'if cat');
    },
  ],
  [
    'change detection drops the diff status',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace('if ! git diff', 'if git diff');
    },
  ],
  [
    'change detection leaves the step shell options changed',
    workflow => {
      const step = workflow.jobs[prepareJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace('\nset -o pipefail', '');
    },
  ],
  [
    'merge change detection drops its matcher verdict',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.id === 'merge_changes');
      step.run = step.run.replace('if set +o pipefail && cat', 'if cat');
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
    'PR dump job drops the schema workspace install',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item =>
        /pnpm install .*--filter web/.test(item.run ?? '')
      );
      step.run = 'pnpm install --frozen-lockfile --filter web...';
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

test('derived coverage check rejects a schema workspace dropped from the patterns', () => {
  const workflow = readWorkflow();
  for (const [jobName, stepId] of [
    [prepareJobName, 'catalog_changes'],
    [mergeJobName, 'merge_changes'],
  ]) {
    const step = workflow.jobs[jobName].steps.find(item => item.id === stepId);
    const widened = step.run.replaceAll('^packages/(app-shared|', '^packages/(not-app-shared|');
    assert.notEqual(widened, step.run, `${jobName}: the app-shared alternative must exist`);
    step.run = widened;
  }
  assert.ok(
    uncoveredCatalogInputs(workflow).some(entry => entry.startsWith('packages/app-shared/src/')),
    'dropping app-shared from the patterns must be reported as uncovered'
  );
});

function dropStep(workflow, jobName, predicate) {
  const job = workflow.jobs[jobName];
  const index = job.steps.findIndex(predicate);
  assert.ok(index >= 0, `mutation target exists in ${jobName}`);
  job.steps.splice(index, 1);
}

function addStep(workflow, jobName, step) {
  workflow.jobs[jobName].steps.push(step);
}
