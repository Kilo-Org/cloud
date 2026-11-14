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
const wiringCommand = 'node --test scripts/kilo-mcp-catalog.test.mjs';
// One install pass serves both the wiring check and the dump: the root project
// the check reads, the web closure the dump parses, and `cloud-agent-next`,
// whose schemas the dump imports by relative path. A second pass would resolve
// and link the same lockfile again over the same store.
const installCommand =
  "pnpm install --frozen-lockfile --filter 'web...' --filter cloud-agent-next --filter kilocode-monorepo";
const skillPath = '.kilo/skills/kilo-mcp/SKILL.md';
const embedCommand = 'node services/kilo-mcp/scripts/embed-catalog.ts upsert';
// A cold install downloads large platform packages, so each job resolves the
// version it will install, restores that version's tree from a cache keyed on
// it, and takes the registry path only on a miss, a version mismatch, or a tree
// the binary cannot start from. A stalled registry request must not hold the
// runner until the job timeout, so the miss path bounds the whole install with a
// time budget and retries an early failure with whatever budget is left.
const kiloVersionCommand = [
  'set -euo pipefail',
  'deadline=$((SECONDS + 60))',
  'for attempt in 1 2 3; do',
  '  remaining=$((deadline - SECONDS))',
  '  if [ "$remaining" -le 0 ]; then',
  '    break',
  '  fi',
  '  if version="$(timeout --signal=TERM --kill-after=10 "$remaining" npm view @kilocode/cli version)"; then',
  '    echo "version=$version" >> "$GITHUB_OUTPUT"',
  '    exit 0',
  '  fi',
  '  if [ "$attempt" -lt 3 ] && [ $((deadline - SECONDS)) -gt $((attempt * 5)) ]; then',
  '    echo "::warning::Resolving the Kilo CLI version did not finish; retrying"',
  '    sleep $((attempt * 5))',
  '  fi',
  'done',
  'echo "::error::Could not resolve the Kilo CLI version from the registry"',
  'exit 1',
  '',
].join('\n');
const kiloCachePath = '${{ runner.temp }}/kilo-cli';
const kiloCacheKey =
  '${{ runner.os }}-${{ runner.arch }}-kilo-cli-${{ steps.kilo_cli_version.outputs.version }}';
// Only the main-branch job writes the tree. A save from a pull_request run is
// scoped to that pull request, so the PR job would upload it once per
// catalog-relevant PR and no other run could restore that copy.
const kiloCacheSave = 'actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7';
const kiloCacheRestore = 'actions/cache/restore@668228422ae6a00e4ad889ee87cd7109ec5666a7';
// Matches either coordinate, for mutations that target the step by name.
const kiloCacheAnyAction = step => (step.uses ?? '').startsWith('actions/cache');
const kiloInstallCommand = [
  'set -euo pipefail',
  'echo "$KILO_CLI_PREFIX/bin" >> "$GITHUB_PATH"',
  '',
  'manifest="$KILO_CLI_PREFIX/lib/node_modules/@kilocode/cli/package.json"',
  'installed=$(node -p "require(\'$manifest\').version" 2>/dev/null || true)',
  '',
  '# A miss, a tree of another version, or a tree the binary cannot start',
  '# from takes the registry path.',
  'if [ "$CACHE_HIT" = "true" ] && [ "$installed" = "$KILO_CLI_VERSION" ] \\',
  '  && "$KILO_CLI_PREFIX/bin/kilo" --version > /dev/null 2>&1; then',
  '  echo "Restored @kilocode/cli@$installed from the cache"',
  '  "$KILO_CLI_PREFIX/bin/kilo" --version',
  '  exit 0',
  'fi',
  '',
  'rm -rf "$KILO_CLI_PREFIX"',
  'deadline=$((SECONDS + 720))',
  'for attempt in 1 2 3; do',
  '  remaining=$((deadline - SECONDS))',
  '  if [ "$remaining" -le 0 ]; then',
  '    break',
  '  fi',
  '  if timeout --signal=TERM --kill-after=20 "$remaining" npm install --global --prefix "$KILO_CLI_PREFIX" "@kilocode/cli@$KILO_CLI_VERSION" --no-audit --no-fund; then',
  '    installed=$(node -p "require(\'$manifest\').version")',
  '    if [ "$installed" != "$KILO_CLI_VERSION" ]; then',
  '      echo "::error::Installed @kilocode/cli@$installed but resolved version $KILO_CLI_VERSION"',
  '      exit 1',
  '    fi',
  '    "$KILO_CLI_PREFIX/bin/kilo" --version',
  '    exit 0',
  '  fi',
  '  if [ "$attempt" -lt 3 ] && [ $((deadline - SECONDS)) -gt $((attempt * 5)) ]; then',
  '    echo "::warning::Kilo CLI install attempt ${attempt} did not finish; retrying"',
  '    sleep $((attempt * 5))',
  '  fi',
  'done',
  'echo "::error::Kilo CLI install did not finish"',
  'exit 1',
  '',
].join('\n');
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

/**
 * The dump shells out to `kilo run`, so both catalog jobs need the published
 * CLI. Each one resolves the version it installs, restores that version's tree
 * from a cache keyed on it, and reaches the registry only on a miss, a version
 * mismatch, or a tree the binary cannot start from. Only the main-branch job
 * saves the tree; the PR job restores the entry main wrote and saves nothing.
 */
function assertKiloCliSteps(job, gate, jobName, cacheAction) {
  const resolve = findStep(
    job,
    step => step.run === kiloVersionCommand,
    'resolves the Kilo CLI version it installs'
  );
  assert.equal(
    resolve.id,
    'kilo_cli_version',
    `${jobName}: the resolved version feeds the cache key`
  );
  assert.equal(
    resolve.if,
    gate,
    `${jobName}: version resolution is gated on catalog-relevant changes`
  );
  assert.equal(
    resolve['timeout-minutes'],
    2,
    `${jobName}: version resolution must be bounded, or a stalled registry request holds the runner`
  );

  const restore = findStep(
    job,
    step => step.uses === cacheAction,
    'restores the cached Kilo CLI tree'
  );
  assert.equal(
    restore.id,
    'kilo_cli_cache',
    `${jobName}: the restore exposes its hit to the install`
  );
  assert.equal(
    restore.if,
    gate,
    `${jobName}: the cache restore is gated on catalog-relevant changes`
  );
  assert.equal(
    restore['continue-on-error'],
    true,
    `${jobName}: a cache failure must never fail the job`
  );
  assert.equal(restore.with?.path, kiloCachePath, `${jobName}: the cache holds the install prefix`);
  assert.equal(
    restore.with?.key,
    kiloCacheKey,
    `${jobName}: the cache key must name the resolved version, or a hit is a tree of another release`
  );

  const install = findStep(
    job,
    step => step.run === kiloInstallCommand,
    'installs the Kilo CLI the dump shells out to'
  );
  assert.equal(install.if, gate, `${jobName}: the install is gated on catalog-relevant changes`);
  assert.equal(
    install.env?.CACHE_HIT,
    '${{ steps.kilo_cli_cache.outputs.cache-hit }}',
    `${jobName}: the install must read the cache hit, or the restored tree is never trusted`
  );
  assert.equal(
    install.env?.KILO_CLI_VERSION,
    '${{ steps.kilo_cli_version.outputs.version }}',
    `${jobName}: the install must pin the version the cache key names`
  );

  const resolveIndex = job.steps.indexOf(resolve);
  const restoreIndex = job.steps.indexOf(restore);
  const installIndex = job.steps.indexOf(install);
  assert.ok(
    resolveIndex < restoreIndex && restoreIndex < installIndex,
    `${jobName}: the version, then its cache entry, then the install`
  );
  assert.ok(
    installIndex < job.steps.findIndex(step => step.run === dumpCommand),
    `${jobName}: the CLI must be installed before the dump shells out to it`
  );

  return install;
}

/**
 * The Kilo CLI tree has exactly one writer. A cache entry saved by a
 * pull_request run is scoped to that pull request, so a PR-side save uploads
 * the tree once per catalog-relevant PR and no other run can restore that copy;
 * the entry every PR restores is the one the main-branch job saves. This
 * mirrors .github/actions/ttsc-plugin-cache/action.yml, which restores in the
 * consumer and leaves the save to the populating job.
 */
function assertSingleKiloCliCacheWriter(workflow) {
  const writers = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      const uses = step.uses ?? '';
      if (!/^actions\/cache(\/save)?@/.test(uses)) continue;
      if (!(step.with?.path ?? '').includes('kilo-cli')) continue;
      writers.push(`${jobName}: ${step.name}`);
    }
  }
  assert.deepEqual(
    writers,
    [`${mergeJobName}: Restore Kilo CLI`],
    `the main-branch job is the only writer of the Kilo CLI tree; a pull_request save is scoped to that PR and every PR restores the main-branch entry`
  );
}

/**
 * A frozen-lockfile install of the web closure resolves ~2.5k packages. The
 * shared store is content-addressed, so a run that arrives with a new lockfile
 * only adds what it does not hold yet; setup-node's pnpm cache is keyed by the
 * lockfile hash with no restore key, so that run restores no store at all and
 * downloads the whole closure from the registry.
 */
function assertPnpmStoreSteps(job, gate, jobName) {
  const pnpm = findStep(
    job,
    step => (step.uses ?? '').startsWith('pnpm/action-setup@'),
    'sets up pnpm'
  );
  const mount = findStep(
    job,
    step => step.uses === './.github/actions/pnpm-store',
    'mounts the shared pnpm store'
  );
  assert.equal(mount.if, gate, `${jobName}: the store mount is gated on catalog-relevant changes`);
  const node = findStep(
    job,
    step => (step.uses ?? '').startsWith('actions/setup-node@'),
    'sets up Node'
  );
  assert.equal(
    node.with?.cache,
    undefined,
    `${jobName}: a lockfile-keyed setup-node cache restores nothing on a lockfile move; the store replaces it`
  );
  const mountIndex = job.steps.indexOf(mount);
  assert.ok(
    job.steps.indexOf(pnpm) < mountIndex && mountIndex < job.steps.indexOf(node),
    `${jobName}: pnpm, then the store mount, then Node`
  );
  const installIndex = job.steps.findIndex(step => /^pnpm\b.*\binstall\b/.test(step.run ?? ''));
  assert.ok(
    mountIndex < installIndex,
    `${jobName}: the store must be mounted before the install it warms`
  );
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
  // The changes job carries several inline filter steps, so the one that
  // defines the backend filter is selected by its content, not by order.
  const filtersByStep = (ci.jobs?.changes?.steps ?? []).flatMap(candidate => {
    if (typeof candidate.with?.filters !== 'string') return [];
    const filters = load(candidate.with.filters);
    return Array.isArray(filters.kilocode_backend) ? [filters] : [];
  });
  const filters = filtersByStep[0];
  assert.ok(filters, 'ci.yml: the changes job must carry kilocode_backend as an inline filter');
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
  assertKiloCliSteps(pr, changeGate, 'PR job', kiloCacheRestore);
  assertPnpmStoreSteps(pr, changeGate, 'PR job');

  // One install pass covers the wiring check and the dump. Splitting it back
  // into a root-only pass and a wider pass resolves and links the same
  // lockfile twice in one job.
  const prInstalls = pr.steps.filter(step => /^pnpm\b.*\binstall\b/.test(step.run ?? ''));
  assert.equal(
    prInstalls.length,
    1,
    `${prJobName}: one lockfile install pass, not ${prInstalls.length}`
  );
  assert.equal(
    prInstalls[0].run,
    installCommand,
    `${prJobName}: the install selects the root project, the web closure and cloud-agent-next in one pass`
  );
  assert.equal(
    prInstalls[0].if,
    changeGate,
    `${prJobName}: the install is gated on catalog changes`
  );
  const prWiring = findStep(pr, step => step.run === wiringCommand, 'catalog wiring check step');
  assert.ok(
    pr.steps.indexOf(prInstalls[0]) < pr.steps.indexOf(prWiring),
    `${prJobName}: the install must come before the wiring check it serves`
  );
  assert.ok(
    pr.steps.indexOf(prInstalls[0]) < pr.steps.indexOf(prDump),
    `${prJobName}: the install must come before the dump it serves`
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
  assertKiloCliSteps(merge, mergeChangeGate, 'merge job', kiloCacheSave);
  assertSingleKiloCliCacheWriter(workflow);
  assertPnpmStoreSteps(merge, mergeChangeGate, 'merge job');
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
  // The prune's ids come from git history, never from listing the index: a
  // full list of the production index times out, and a single-step diff would
  // strand the ids of a run whose prune failed.
  const ids = findStep(
    merge,
    step => step.id === 'prune_ids',
    'merge job collects every id the index was ever built from'
  );
  assert.equal(ids.if, mergeChangeGate, 'the id collection is gated with the upsert');
  assert.match(
    ids.run ?? '',
    /git log --format=%H -- services\/kilo-mcp\/catalog\.json/,
    'the ids come from every version of the committed catalog'
  );
  assert.match(ids.run ?? '', /keys\[\]/, 'each version contributes its procedure paths');
  assert.match(ids.run ?? '', /sort -u/, 'the union is deduped');
  // `git log` and `git show` walk every commit, so the walk's prerequisite is a
  // full clone: without it the union silently covers only the pushed range.
  const mergeCheckout = merge.steps.find(step =>
    (step.uses ?? '').startsWith('useblacksmith/checkout@')
  );
  assert.equal(mergeCheckout?.with?.['fetch-depth'], 0, 'the history walk needs the full clone');
  assert.match(
    ids.run ?? '',
    /out="\$RUNNER_TEMP\/catalog-ever-ids\.txt"/,
    'the collection writes the id list to a file'
  );
  assert.match(
    ids.run ?? '',
    /echo "file=\$out" >> "\$GITHUB_OUTPUT"/,
    'the collection publishes its file as the step output'
  );
  assert.ok(
    merge.steps.indexOf(ids) < merge.steps.indexOf(upsert),
    'the id list is collected before the upsert reads it'
  );
  assert.equal(
    upsert.env?.MCP_CATALOG_PRUNE_IDS,
    '${{ steps.prune_ids.outputs.file }}',
    'the upsert prunes from the collected id list'
  );
  const afterIds = merge.steps.slice(merge.steps.indexOf(ids) + 1);
  assert.equal(afterIds[0] === upsert, true, 'the upsert runs immediately after the id collection');
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
    'Kilo CLI cache removed from the merge job',
    workflow => dropStep(workflow, mergeJobName, step => step.uses === kiloCacheSave),
  ],
  [
    'Kilo CLI cache saved by the PR job',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.uses === kiloCacheRestore);
      step.uses = kiloCacheSave;
    },
  ],
  [
    'Kilo CLI cache written only by the PR job',
    workflow => {
      const step = workflow.jobs[mergeJobName].steps.find(item => item.uses === kiloCacheSave);
      step.uses = kiloCacheRestore;
    },
  ],
  [
    'Kilo CLI version resolution may stall the job',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.id === 'kilo_cli_version');
      delete step['timeout-minutes'];
    },
  ],
  [
    'Kilo CLI cache key without the resolved version',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => kiloCacheAnyAction(item));
      step.with.key = '${{ runner.os }}-${{ runner.arch }}-kilo-cli';
    },
  ],
  [
    'Kilo CLI cache restore may fail the job',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => kiloCacheAnyAction(item));
      delete step['continue-on-error'];
    },
  ],
  [
    'Kilo CLI cache restored before the version is resolved',
    workflow => {
      const steps = workflow.jobs[prJobName].steps;
      const restoreIndex = steps.findIndex(item => kiloCacheAnyAction(item));
      const [restore] = steps.splice(restoreIndex, 1);
      steps.unshift(restore);
    },
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
  [
    'second lockfile install pass added',
    workflow =>
      addStep(workflow, prJobName, {
        name: 'Install root dependencies',
        if: changeGate,
        run: 'pnpm --filter kilocode-monorepo install --frozen-lockfile --ignore-scripts',
      }),
  ],
  [
    'install narrowed to the root project',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item => item.run === installCommand);
      step.run = 'pnpm --filter kilocode-monorepo install --frozen-lockfile';
    },
  ],
  [
    'pnpm store mount removed from the PR job',
    workflow => dropStep(workflow, prJobName, step => step.uses === './.github/actions/pnpm-store'),
  ],
  [
    'pnpm store mount removed from the merge job',
    workflow =>
      dropStep(workflow, mergeJobName, step => step.uses === './.github/actions/pnpm-store'),
  ],
  [
    'pnpm store mount ungated',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(
        item => item.uses === './.github/actions/pnpm-store'
      );
      delete step.if;
    },
  ],
  [
    'pnpm store mounted after the install',
    workflow => {
      const steps = workflow.jobs[mergeJobName].steps;
      const [mount] = steps.splice(
        steps.findIndex(item => item.uses === './.github/actions/pnpm-store'),
        1
      );
      steps.push(mount);
    },
  ],
  [
    'lockfile-keyed setup-node cache restored',
    workflow => {
      const step = workflow.jobs[prJobName].steps.find(item =>
        (item.uses ?? '').startsWith('actions/setup-node@')
      );
      step.with.cache = 'pnpm';
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
