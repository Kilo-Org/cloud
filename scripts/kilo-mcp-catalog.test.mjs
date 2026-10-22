import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const workflowPath = '.github/workflows/kilo-mcp-catalog.yml';
const testPath = 'scripts/kilo-mcp-catalog.test.mjs';
const prJobName = 'catalog-pr';
const mergeJobName = 'catalog-merge';
const dumpCommand = 'pnpm --filter web script src/scripts/mcp-catalog/dump.ts';
const skillCommand = 'pnpm --filter web script src/scripts/mcp-catalog/skill.ts';
const skillPath = '.kilo/skills/kilo-mcp/SKILL.md';
const embedCommand = 'node services/kilo-mcp/scripts/embed-catalog.ts upsert';
const kiloInstallCommand = 'npm install -g @kilocode/cli';
const mintCommand = 'api/internal/mcp-catalog/token';
const mintSecretEnv = '${{ secrets.MCP_CATALOG_TOKEN_SECRET }}';
const mergeGate = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const forkCondition = 'github.event.pull_request.head.repo.fork == true';
const sameRepoCondition = 'github.event.pull_request.head.repo.fork == false';
const changeGate = "steps.catalog_changes.outputs.catalog == 'true'";
const mergeChangeGate = "steps.merge_changes.outputs.catalog == 'true'";
// The paths the change-detection step must recognise. The workflow-path
// entries tolerate the grep escaping (`\.yml`, `\.test\.mjs`) so the required
// check keeps running the dump whenever the catalog can actually change, and
// the skill entry keeps `.kilo/skills/kilo-mcp/SKILL.md` inside the detected
// set so a hand-edited skill re-runs the pipeline.
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

/** The `grep -Eq '…'` pattern a change-detection step runs. */
function detectionPattern(step, jobName) {
  const match = /\| grep -Eq '([^']+)'/.exec(step.run ?? '');
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
  assert.deepEqual(Object.keys(workflow.jobs), [prJobName, mergeJobName], 'exactly two jobs');
  const pr = workflow.jobs[prJobName];
  const merge = workflow.jobs[mergeJobName];

  // Triggers: PRs on every branch head (the check is required and must always
  // report); pushes on main only.
  assert.equal(pr.if, "github.event_name == 'pull_request'", `${prJobName}: PR-event only`);
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

  // The job always reports, but only catalog-relevant changes pay for the dump.
  const gate = findStep(pr, step => step.id === 'catalog_changes', 'change-detection step');
  for (const fragment of catalogPathFragments) {
    assert.match(gate.run ?? '', fragment, `change-detection step must recognise ${fragment}`);
  }
  const gateIndex = pr.steps.indexOf(gate);
  for (const step of pr.steps.slice(gateIndex + 1)) {
    assert.match(
      step.if ?? '',
      new RegExp(changeGate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${step.name ?? step.uses}: every post-detection step must be gated on catalog-relevant changes`
    );
  }

  // The merge job runs on every main push but gates the dump and the upsert on
  // the same catalog paths, so an unrelated main push stays cheap (requirement
  // 9/22) without leaving the required check "Expected".
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
  const mergeGateIndex = merge.steps.indexOf(mergeDetect);
  for (const step of merge.steps.slice(mergeGateIndex + 1)) {
    assert.match(
      step.if ?? '',
      new RegExp(mergeChangeGate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${step.name ?? step.uses}: every post-detection step in the merge job must be gated on catalog-relevant changes`
    );
  }

  // The PR job runs the real dump script with a short-lived benchmarking
  // token mint (requirement 2), never a maintainer's personal credential, and
  // keeps author edits through the dump's own keep-edit rule (requirement 5).
  const prDump = findStep(pr, step => step.run === dumpCommand, 'PR job runs the real dump script');
  const prMint = findStep(pr, step => step.id === 'mint', 'PR job mints a catalog token');
  assert.equal(
    prMint.env?.MCP_CATALOG_TOKEN_SECRET,
    mintSecretEnv,
    'PR mint reads the shared mint secret from the repo secret'
  );
  assert.match(prMint.run ?? '', new RegExp(mintCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(prMint.run ?? '', /KILO_API_KEY/, 'PR mint exports the short-lived Kilo API key');
  assert.doesNotMatch(
    JSON.stringify(prDump.env ?? {}),
    /MCP_CATALOG_KILO_AUTH|KILO_AUTH_CONTENT/,
    'PR dump must not use the personal CLI credential'
  );
  findStep(
    pr,
    step => step.run === kiloInstallCommand,
    'PR job installs the Kilo CLI the dump shells out to'
  );

  // The PR job regenerates the skill from the catalog.json the dump just
  // wrote, on the same change gate and with no credentials (s1's generator
  // command; the workflow never imports the generator itself).
  const prSkill = findStep(
    pr,
    step => step.run === skillCommand,
    'PR job regenerates the kilo-mcp skill'
  );
  assert.equal(
    prSkill.if,
    changeGate,
    'PR skill regeneration is gated on catalog-relevant changes'
  );
  assert.ok(
    pr.steps.indexOf(prDump) < pr.steps.indexOf(prSkill),
    'PR skill regeneration must run after the dump, so it reads the refreshed catalog.json'
  );

  // Fork PRs never receive the mint secret (GitHub withholds secrets from
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
  for (const step of pr.steps) {
    assert.doesNotMatch(
      stepText(step),
      /embed-catalog|catalog:embed|vectorize|CLOUDFLARE/i,
      `${prJobName}: no PR-triggered step may reference the embed script or Vectorize`
    );
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

  // Merge job: dump fills stragglers (requirement 8), the skill is regenerated
  // from it, then the embed script upserts Vectorize with the Cloudflare
  // credentials (requirement 9).
  const mergeDump = findStep(merge, step => step.run === dumpCommand, 'merge job runs the dump');
  const mergeMint = findStep(merge, step => step.id === 'mint', 'merge job mints a catalog token');
  assert.equal(
    mergeMint.env?.MCP_CATALOG_TOKEN_SECRET,
    mintSecretEnv,
    'merge mint reads the shared mint secret from the repo secret'
  );
  assert.doesNotMatch(
    JSON.stringify(mergeDump.env ?? {}),
    /MCP_CATALOG_KILO_AUTH|KILO_AUTH_CONTENT/,
    'merge dump must not use the personal CLI credential'
  );
  findStep(
    merge,
    step => step.run === kiloInstallCommand,
    'merge job installs the Kilo CLI the dump shells out to'
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
    'the merge drift check must run between the dump and the Vectorize upsert'
  );
  assert.ok(
    merge.steps.indexOf(mergeDump) < merge.steps.indexOf(mergeSkill) &&
      merge.steps.indexOf(mergeSkill) < merge.steps.indexOf(mergeDrift),
    'the merge skill must be regenerated after the dump and before the stale check'
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
    workflow.jobs[prJobName],
    step => step.id === 'catalog_changes',
    'PR change-detection step'
  );
  const mergeStep = findStep(
    workflow.jobs[mergeJobName],
    step => step.id === 'merge_changes',
    'merge change-detection step'
  );
  const prPattern = detectionPattern(pr, prJobName);
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
  [
    'merge drift check removed',
    workflow =>
      dropStep(workflow, mergeJobName, step =>
        /git diff --exit-code[\s\S]*services\/kilo-mcp\/catalog\.json/.test(step.run ?? '')
      ),
  ],
  [
    'PR dump reverted to the personal credential',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.run === dumpCommand);
      step.env = { KILO_AUTH_CONTENT: '${{ secrets.MCP_CATALOG_KILO_AUTH }}' };
    },
  ],
  [
    'PR mint secret changed',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.id === 'mint');
      step.env.MCP_CATALOG_TOKEN_SECRET = '${{ secrets.SOMETHING_ELSE }}';
    },
  ],
  [
    'change-detection gate removed',
    workflow => dropStep(workflow, prJobName, step => step.id === 'catalog_changes'),
  ],
  [
    'change-detection drops a catalog path',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.id === 'catalog_changes');
      step.run = step.run.replace('^services/kilo-mcp/', '^services/other/');
    },
  ],
  [
    'a post-detection step escapes the gate',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.run === dumpCommand);
      delete step.if;
    },
  ],
  ['push paths filter added', workflow => (workflow.on.push.paths = ['apps/web/src/**'])],
  [
    'merge change-detection step removed',
    workflow => dropStep(workflow, mergeJobName, step => step.id === 'merge_changes'),
  ],
  [
    'merge dump step escapes the gate',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.run === dumpCommand);
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
    'skill path dropped from the PR change detection',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.id === 'catalog_changes');
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
    'skill step moved before the dump',
    workflow => {
      const steps = workflow.jobs[prJobName].steps;
      const skill = steps.find(step => step.run === skillCommand);
      const dumpIndex = steps.findIndex(step => step.run === dumpCommand);
      steps.splice(steps.indexOf(skill), 1);
      steps.splice(dumpIndex, 0, skill);
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
    [prJobName, 'catalog_changes'],
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
