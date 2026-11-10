import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

import { DEPENDENCY_INPUTS } from './affected-workspaces.mjs';

const workflows = Object.fromEntries(
  [
    'ci.yml',
    'extension-ci.yml',
    'kilo-app-ci.yml',
    'mobile-native-build.yml',
    'explorer-ios-release.yml',
  ].map(file => [
    file,
    load(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')),
  ])
);
const harnessBuildAction = load(
  readFileSync(new URL('../.github/actions/harness-sdk-build/action.yml', import.meta.url), 'utf8')
);
const pluginCacheActionYaml = load(
  readFileSync(new URL('../.github/actions/ttsc-plugin-cache/action.yml', import.meta.url), 'utf8')
);
const extension = JSON.parse(
  readFileSync(new URL('../apps/extension/package.json', import.meta.url), 'utf8')
);
const rootScript = fileURLToPath(new URL('./typecheck-all.sh', import.meta.url));
const harnessBuild = 'pnpm --filter @kilocode/harness-sdk run build';
const pluginCacheAction = './.github/actions/ttsc-plugin-cache';
const pluginPath = 'node_modules/.cache/ttsc/plugins';
// The step each plugin saver's save must follow.
const jobRun = new Map([
  ['ci.yml:harness-sdk', 'pnpm --filter @kilocode/harness-sdk check:ci'],
  ['ci.yml:workspace-tests', 'pnpm --filter ${{ matrix.workspace.name }} test'],
  ['.github/actions/harness-sdk-build', harnessBuild],
]);
const ciJobs = workflows['ci.yml'].jobs;
const kiloAppJobs = workflows['kilo-app-ci.yml'].jobs;
const pnpmCleanup = fileURLToPath(
  new URL('../.github/actions/pnpm-store/cleanup/cleanup.cjs', import.meta.url)
);

// A required status check matches by context name and app, so two workflows
// publishing one required name let either workflow's pass satisfy the ruleset.
// The main-tests ruleset (12440145) requires these contexts. The mobile three
// are required as well because ci.yml excludes apps/mobile from its lint and
// workspace-test rows: without them a mobile-only PR could pass the ruleset on
// skipped ci.yml rows. The mobile workflow mirrors work ci.yml also runs, so
// those jobs carry a `mobile-` prefix and only the mobile workflow publishes
// them. `i18n-leftover` and `check-unused` have no other publisher, so a rename
// there would leave a required check unreported.
const requiredContexts = [
  'test',
  'build',
  'typecheck',
  'format-check',
  'catalog (PR)',
  'i18n-leftover',
  'check-unused',
  'lint',
  'mobile-typecheck',
  'mobile-lint',
  'mobile-test-result',
];

function publishingJobs(workflow) {
  return Object.entries(workflow.jobs ?? {}).map(([id, job]) => ({
    id,
    name: typeof job?.name === 'string' ? job.name : id,
  }));
}

test('each required check name is published by exactly one pull-request workflow', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const publishers = new Map(requiredContexts.map(name => [name, []]));
  for (const file of readdirSync(directory)
    .filter(name => /\.ya?ml$/.test(name))
    .sort()) {
    const workflow = load(readFileSync(new URL(file, directory), 'utf8'));
    const triggers = workflow.on ?? {};
    // A workflow without these triggers never reports a check on a PR or a
    // merge-queue entry, so its job names cannot satisfy the ruleset there.
    if (!('pull_request' in triggers) && !('merge_group' in triggers)) continue;
    for (const { id, name } of publishingJobs(workflow)) {
      publishers.get(name)?.push(`${file}:${id}`);
    }
  }
  for (const [name, found] of publishers) {
    assert.equal(
      found.length,
      1,
      `required context ${name} must have one publisher, found ${found.join(', ') || 'none'}`
    );
  }
  // The names ci.yml owns are the ones the mobile workflow used to duplicate.
  assert.equal(publishers.get('test')[0], 'ci.yml:test');
  assert.equal(publishers.get('typecheck')[0], 'ci.yml:typecheck');
  assert.equal(publishers.get('lint')[0], 'ci.yml:lint');
  // A required context whose name is prefixed must come from the mobile
  // workflow: no other workflow may publish one.
  for (const [name, found] of publishers) {
    if (name.startsWith('mobile-')) {
      assert.deepEqual(
        found,
        [`kilo-app-ci.yml:${name}`],
        `${name} belongs to the mobile workflow`
      );
    }
  }
  // These two required contexts exist only in the mobile workflow, so they keep
  // their unprefixed names and must not move to ci.yml or another workflow.
  assert.deepEqual(publishers.get('i18n-leftover'), ['kilo-app-ci.yml:i18n-leftover']);
  assert.deepEqual(publishers.get('check-unused'), ['kilo-app-ci.yml:check-unused']);
});

test('the mobile workflow publishes no colliding required check name', () => {
  const ids = Object.keys(workflows['kilo-app-ci.yml'].jobs);
  for (const name of ['mobile-typecheck', 'mobile-lint', 'mobile-test-result']) {
    assert.ok(ids.includes(name), `the mobile workflow publishes ${name}`);
  }
  for (const name of ['typecheck', 'lint', 'test']) {
    assert.ok(!ids.includes(name), `the mobile workflow must not publish ${name}`);
  }
});

test('dependency cache keeps only the content store on the mounted filesystem', t => {
  const action = load(
    readFileSync(new URL('../.github/actions/pnpm-store/action.yml', import.meta.url), 'utf8')
  );
  const mount = action.runs.steps.find(step => step.uses?.startsWith('useblacksmith/stickydisk@'));
  assert.equal(mount.with.path, './node_modules');
  assert.equal(
    mount.with.key,
    '${{ github.repository }}-node-modules-${{ runner.os }}-${{ runner.arch }}'
  );

  const mountIndex = action.runs.steps.indexOf(mount);
  const cleanupIndex = action.runs.steps.findIndex(
    step => step.name === 'Reset pnpm installed graph'
  );
  const configureIndex = action.runs.steps.findIndex(step => step.name === 'Configure pnpm store');
  assert.ok(mountIndex < cleanupIndex && cleanupIndex < configureIndex);

  const workspace = mkdtempSync(join(tmpdir(), 'pnpm-cache-cleanup-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const modules = join(workspace, 'node_modules');
  const store = join(modules, '.pnpm-store');
  mkdirSync(join(store, 'v11/files'), { recursive: true });
  writeFileSync(join(store, 'v11/files/content'), 'cached package');
  mkdirSync(join(modules, '.pnpm/node_modules'), { recursive: true });
  mkdirSync(join(modules, '.bin'), { recursive: true });
  writeFileSync(join(modules, '.modules.yaml'), 'stale metadata');
  writeFileSync(join(modules, '.pnpm/lock.yaml'), 'stale graph');
  symlinkSync('../package', join(modules, 'stale-package'));

  const cleanup = action.runs.steps.find(step => step.name === 'Reset pnpm installed graph');
  assert.equal(cleanup.uses, './.github/actions/pnpm-store/cleanup');
  const cleanupAction = load(
    readFileSync(
      new URL('../.github/actions/pnpm-store/cleanup/action.yml', import.meta.url),
      'utf8'
    )
  );
  assert.equal(cleanupAction.runs.main, 'cleanup.cjs');
  assert.equal(cleanupAction.runs.post, 'cleanup.cjs');
  assert.equal(cleanupAction.runs['post-if'], 'always()');

  const result = spawnSync(process.execPath, [pnpmCleanup], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKSPACE: workspace },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(store, 'v11/files/content'), 'utf8'), 'cached package');
  assert.equal(existsSync(join(modules, '.pnpm')), false);
  assert.equal(existsSync(join(modules, '.modules.yaml')), false);
  assert.equal(existsSync(join(modules, '.bin')), false);
  assert.equal(existsSync(join(modules, 'stale-package')), false);
  assert.ok(
    action.runs.steps.some(step =>
      step.run?.includes('pnpm_config_store_dir=$GITHUB_WORKSPACE/node_modules/.pnpm-store')
    )
  );

  const missingMountWorkspace = mkdtempSync(join(tmpdir(), 'pnpm-cache-missing-mount-'));
  t.after(() => rmSync(missingMountWorkspace, { recursive: true, force: true }));
  const missingMountResult = spawnSync(process.execPath, [pnpmCleanup], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_WORKSPACE: missingMountWorkspace },
  });
  assert.equal(missingMountResult.status, 0, missingMountResult.stderr);
});

// The reset runs before install and again after the job, so it must never reach
// anything except the checkout's own node_modules tree.
test('pnpm reset keeps every deletion inside the checkout', t => {
  const base = mkdtempSync(join(tmpdir(), 'pnpm-cache-reset-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const shared = join(base, 'shared');
  const sharedFile = join(shared, 'cache', 'content');
  mkdirSync(join(shared, 'cache'), { recursive: true });
  writeFileSync(sharedFile, 'shared content');

  const runCleanup = workspace =>
    spawnSync(process.execPath, [pnpmCleanup], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_WORKSPACE: workspace },
    });

  const linked = join(base, 'linked');
  mkdirSync(linked);
  symlinkSync(shared, join(linked, 'node_modules'));
  const linkedResult = runCleanup(linked);
  assert.equal(linkedResult.status, 0, linkedResult.stderr);
  assert.match(linkedResult.stdout, /::warning::/);
  assert.equal(readFileSync(sharedFile, 'utf8'), 'shared content');
  assert.equal(lstatSync(join(linked, 'node_modules')).isSymbolicLink(), true);

  const fileRoot = join(base, 'file-root');
  mkdirSync(fileRoot);
  writeFileSync(join(fileRoot, 'node_modules'), 'not a directory');
  const fileResult = runCleanup(fileRoot);
  assert.equal(fileResult.status, 0, fileResult.stderr);
  assert.match(fileResult.stdout, /::warning::/);
  assert.equal(readFileSync(join(fileRoot, 'node_modules'), 'utf8'), 'not a directory');

  const linkedWorkspace = join(base, 'symlinked-workspace');
  const realWorkspace = join(base, 'real-workspace');
  mkdirSync(join(realWorkspace, 'node_modules', '.pnpm'), { recursive: true });
  writeFileSync(join(realWorkspace, 'node_modules', '.modules.yaml'), 'stale metadata');
  symlinkSync(shared, join(realWorkspace, 'node_modules', 'shared-package'));
  symlinkSync(realWorkspace, linkedWorkspace);
  const symlinkedWorkspaceResult = runCleanup(linkedWorkspace);
  assert.equal(symlinkedWorkspaceResult.status, 0, symlinkedWorkspaceResult.stderr);
  assert.equal(existsSync(join(realWorkspace, 'node_modules', '.pnpm')), false);
  assert.equal(existsSync(join(realWorkspace, 'node_modules', '.modules.yaml')), false);
  assert.equal(existsSync(join(realWorkspace, 'node_modules', 'shared-package')), false);
  assert.equal(readFileSync(sharedFile, 'utf8'), 'shared content');

  const withoutWorkspace = { ...process.env };
  delete withoutWorkspace.GITHUB_WORKSPACE;
  const missingResult = spawnSync(process.execPath, [pnpmCleanup], {
    encoding: 'utf8',
    env: withoutWorkspace,
  });
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /GITHUB_WORKSPACE is required/);

  const relativeResult = runCleanup('relative/checkout');
  assert.notEqual(relativeResult.status, 0);
  assert.match(relativeResult.stderr, /absolute/);
});

// A frozen-lockfile install without a warm dependency source refetches every
// package on each run. Jobs on a Blacksmith runner mount the shared store; jobs
// on another runner use setup-node's pnpm cache instead.
test('every workflow install job restores a pnpm dependency cache', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const uncached = [];
  for (const file of readdirSync(directory)
    .filter(name => /\.ya?ml$/.test(name))
    .sort()) {
    const workflow = load(readFileSync(new URL(file, directory), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = (job.steps ?? []).filter(step => step !== null && typeof step === 'object');
      const installIndex = steps.findIndex(step =>
        (step.run ?? '').split('\n').some(line => /\bpnpm\b.*\binstall\b/.test(line))
      );
      if (installIndex < 0) continue;
      const warmIndex = steps.findIndex(
        step =>
          step.uses === './.github/actions/pnpm-store' ||
          (String(step.uses).startsWith('actions/setup-node@') && step.with?.cache === 'pnpm')
      );
      // A mount or cache step after the install warms nothing.
      if (warmIndex < 0 || warmIndex > installIndex) uncached.push(`${file}:${jobName}`);
    }
  }
  assert.deepEqual(uncached, [], 'an install job must restore a pnpm cache before it installs');
});

// The apt-get behind `playwright install --with-deps` runs to the job timeout
// whenever the runner fleet's apt egress degrades, and the runner images
// already ship the Chromium system libraries. A browser build that the
// version-keyed cache does not satisfy is downloaded, never apt-installed.
// chromatic.yml is disabled in the repository's Actions settings, so its jobs
// run nowhere; it is left as it is until the workflow is re-enabled.
const disabledWorkflows = new Set(['chromatic.yml']);

test('every Chromium install skips apt and restores the browser cache first', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const cacheKey =
    '${{ runner.os }}-${{ runner.arch }}-playwright-${{ steps.playwright.outputs.version }}';
  const installs = [];
  for (const file of readdirSync(directory)
    .filter(name => /\.ya?ml$/.test(name))
    .sort()) {
    if (disabledWorkflows.has(file)) continue;
    const workflow = load(readFileSync(new URL(file, directory), 'utf8'));
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = (job.steps ?? []).filter(step => step !== null && typeof step === 'object');
      steps.forEach((step, index) => {
        if (!/\bplaywright\b.*\binstall\b/.test(step.run ?? '')) return;
        installs.push(`${file}:${jobName}`);
        assert.doesNotMatch(
          step.run,
          /--with-deps/,
          `${file}:${jobName} must install Chromium without apt`
        );
        const cacheIndex = steps.findIndex(
          candidate =>
            String(candidate.uses).startsWith('actions/cache@') &&
            candidate.with?.path === '~/.cache/ms-playwright'
        );
        assert.ok(
          cacheIndex >= 0 && cacheIndex < index,
          `${file}:${jobName} must restore the browser cache before it installs`
        );
        assert.equal(steps[cacheIndex].with.key, cacheKey, `${file}:${jobName} cache key`);
      });
    }
  }
  assert.deepEqual(
    installs,
    [
      'ci.yml:mobile-diagram-host',
      'extension-ci.yml:e2e-chrome-shard',
      'setup-smoke.yml:setup-smoke',
    ],
    'every Chromium install in a live workflow is covered'
  );
});

for (const [file, name, command, condition] of [
  ['ci.yml', 'typecheck-groups', 'scripts/typecheck-all.sh --group ${{ matrix.group }}'],
  ['ci.yml', 'typecheck-trpc', 'scripts/typecheck-all.sh --group trpc'],
  ['ci.yml', 'harness-sdk', 'pnpm --filter @kilocode/harness-sdk check:ci'],
  [
    'ci.yml',
    'workspace-tests',
    'pnpm --filter ${{ matrix.workspace.name }} test',
    "matrix.workspace.name == '@kilocode/harness-sdk'",
  ],
]) {
  test(`${file} ${name} restores the compiler plugin cache after install and before use`, () => {
    const steps = workflows[file].jobs[name].steps;
    const cacheIndex = steps.findIndex(step => step.uses === pluginCacheAction);
    const installIndex = steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    const buildIndex = steps.findIndex(step => step.run === command);
    assert.ok(installIndex >= 0 && cacheIndex > installIndex && buildIndex > cacheIndex);
    const cache = steps[cacheIndex];
    // The harness-sdk row of workspace-tests is the only saver; these jobs
    // restore through the action and compile on a miss when it was skipped.
    assert.equal(cache.with, undefined);
    assert.equal(cache.if, condition ?? steps[buildIndex].if);
  });
}

test('one job saves the compiler plugin cache and every reader restores it', () => {
  const savers = [];
  const holders = [
    ...Object.entries(workflows).flatMap(([file, workflow]) =>
      Object.entries(workflow.jobs ?? {}).map(([name, job]) => [`${file}:${name}`, job.steps ?? []])
    ),
    ['.github/actions/harness-sdk-build', harnessBuildAction.runs.steps],
  ];
  for (const [key, steps] of holders) {
    // An action may also save another cache (the harness SDK dist is one), so
    // pick the plugin saves by their path rather than by the action.
    const saversHere = steps.filter(
      step => step.uses?.startsWith('actions/cache/save@') && step.with?.path === pluginPath
    );
    for (const save of saversHere) {
      assert.equal(save.uses, 'actions/cache/save@668228422ae6a00e4ad889ee87cd7109ec5666a7');
      assert.ok(
        (save.if ?? '').includes("steps.plugins.outputs.cache-hit != 'true'"),
        `${key} saves only what its own restore missed`
      );
      assert.equal(save.with.path, pluginPath);
      assert.equal(
        save.with.key,
        '${{ runner.os }}-${{ runner.arch }}-ttsc-plugins-${{ steps.plugins.outputs.key }}',
        `${key} saves under the key its restore read`
      );
      savers.push(key);
    }
    const restore = steps.find(step => step.uses === pluginCacheAction);
    if (restore) {
      // The save must follow the compilation: an inline save inside a restore
      // action would fire before ttsc wrote the plugins.
      if (saversHere.length > 0) {
        const saveIndex = steps.indexOf(saversHere.at(-1));
        const runIndex = steps.findIndex(step => step.run === jobRun.get(key));
        assert.ok(restore.id, `${key} must expose the plugin restore to its save`);
        assert.ok(saveIndex > runIndex, `${key} saves after its run compiles`);
      } else {
        assert.equal(restore.with, undefined, `${key} restores only`);
      }
    }
  }
  // Each Linux selection path has one saver: the dedicated harness-sdk job
  // when the packages/harness-sdk filter selected it, and the workspace-tests
  // row otherwise (whose matrix then carries the harness-sdk work). macOS has
  // no ci.yml reviewer, so the build action writes the macOS key itself.
  assert.deepEqual(savers, [
    'ci.yml:harness-sdk',
    'ci.yml:workspace-tests',
    '.github/actions/harness-sdk-build',
  ]);
  assert.equal(
    ciJobs['workspace-tests'].steps.find(step => step.uses?.startsWith('actions/cache/save@')).if,
    "matrix.workspace.name == '@kilocode/harness-sdk' && steps.plugins.outputs.cache-hit != 'true' && needs.changes.outputs.harness_sdk != 'true'",
    'the two savers must not both save in one run'
  );
});

// mobile-native-build runs the action once, in `prepare-harness-sdk`, and both
// platform jobs download its artifact instead; the test below pins that split.
const harnessBuildGuards = [
  ['ci.yml', 'lint-trpc', "contains(fromJSON(needs.changes.outputs.affected).full_checks, 'lint')"],
  [
    'explorer-ios-release.yml',
    'build',
    "hashFiles('.github/actions/harness-sdk-build/action.yml') != ''",
  ],
];

test('every consumer job restores or builds the harness SDK through the action', () => {
  for (const [file, name, guard] of harnessBuildGuards) {
    const steps = workflows[file].jobs[name].steps;
    const installIndex = steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    const actionIndex = steps.findIndex(
      step => step.uses === './.github/actions/harness-sdk-build'
    );
    assert.ok(
      installIndex >= 0 && actionIndex > installIndex,
      `${file}:${name} runs the action after install`
    );
    assert.equal(steps[actionIndex].if, guard, `${file}:${name} keeps its guard`);
    // explorer-ios-release checks out an arbitrary cloud_ref, which can predate
    // the action; it is the only job allowed a plain build, behind the
    // complementary guard.
    const plain = steps.filter(step => step.run === harnessBuild);
    if (file !== 'explorer-ios-release.yml') {
      assert.deepEqual(
        plain.map(step => step.name),
        [],
        `${file}:${name} never builds outside`
      );
    } else {
      assert.equal(plain.length, 1);
      assert.equal(plain[0].if, "hashFiles('.github/actions/harness-sdk-build/action.yml') == ''");
    }
  }
});

// The probe decides whether the build is needed, and the condition sits on the
// job: a step condition still reserves the macOS runner for the dispatch it
// skips. A probe with no answer publishes no output, so the build runs; only a
// proven `true` skips it.
test('explorer-ios-release skips the whole build job on a probe hit', () => {
  const { build, upload } = workflows['explorer-ios-release.yml'].jobs;
  assert.equal(build.needs, 'probe', 'the job condition reads the probe output');
  const condition = build.if ?? '';
  assert.match(condition, /!cancelled\(\)/, 'a failed probe must still reach the build');
  assert.match(
    condition,
    /needs\.probe\.outputs\.exists != 'true'/,
    'only a proven existing object skips the job'
  );
  assert.deepEqual(
    build.steps
      .filter(step => (step.if ?? '').includes('needs.probe.outputs.exists'))
      .map(step => step.name ?? step.uses),
    [],
    'a step that repeats the job condition is dead weight'
  );
  assert.equal(build.steps[0].name, 'Validate inputs', 'validation stays in the build');
  assert.equal(build.steps[0].if, undefined, 'every dispatch that builds validates its inputs');
  assert.match(
    upload.if,
    /needs\.build\.result == 'success'/,
    'a skipped build must leave the upload skipped'
  );
});

// A probe with no answer must cost the build and nothing else. Without the
// tolerated auth failure the whole run ends `failure` after a build and upload
// that succeeded, so a client waiting on the run reads a published artifact as a
// broken build. A broken identity still reports itself in `upload`, which mints
// the same identity.
test('explorer-ios-release records a probe failure as no answer', () => {
  const probe = workflows['explorer-ios-release.yml'].jobs.probe;
  const auth = probe.steps.find(step => step.uses?.startsWith('google-github-actions/auth@'));
  assert.equal(auth['continue-on-error'], true, 'a refused identity must not fail the run');
  assert.equal(auth.with.create_credentials_file, false, 'the probe needs no credentials file');
  const metadata = probe.steps.find(step => step.id === 'metadata');
  assert.match(
    metadata.run,
    /-z "\$\{ACCESS_TOKEN:-\}"[\s\S]*echo 'exists=false'/,
    'a lookup without a token still answers exists=false'
  );
  assert.equal(probe.outputs.exists, '${{ steps.metadata.outputs.exists }}');
});

// A probe on one object and an upload to another would never agree: a probe
// pointed at a key that still exists would skip a build the upload cannot reuse.
test('explorer-ios-release names its artifact object once', () => {
  const workflow = workflows['explorer-ios-release.yml'];
  assert.match(workflow.env.ARTIFACT_BUCKET, /^[a-z0-9-]+$/);
  assert.match(
    workflow.env.ARTIFACT_OBJECT,
    /^explorers%2Fios%2F\$\{\{ inputs\.fingerprint \}\}\.app\.tar\.gz$/,
    'the object name stays percent-encoded and keyed by the build key'
  );
  const [probe, upload] = ['probe', 'upload'].map(name =>
    workflow.jobs[name].steps
      .map(step => step.run ?? '')
      .filter(script => script.includes('storage.googleapis.com'))
  );
  assert.equal(probe.length, 1);
  assert.equal(upload.length, 1);
  for (const script of [probe[0], upload[0]]) {
    assert.match(script, /\/b\/\$\{ARTIFACT_BUCKET\}\//);
    assert.match(script, /ARTIFACT_OBJECT/);
    assert.doesNotMatch(script, /kwf-planner|explorers%2F/);
  }
});

// The mobile suite needs one harness SDK build, not one per job: the build
// resolves the SDK's whole program and, on a miss, compiles the typia
// transform. Eleven jobs did that concurrently, and actions/cache saves at the
// end of a job, so the eight shards could not hit each other's save.
// `prepare-harness-sdk` builds once and every consumer downloads the result.
const sdkDist = 'packages/harness-sdk/dist';
const sdkArtifact = 'harness-sdk-dist';
const harnessProducer = 'prepare-harness-sdk';
const trpcProducer = 'prepare-trpc';

test('kilo-app CI builds the harness SDK once and every suite downloads it', () => {
  const jobs = workflows['kilo-app-ci.yml'].jobs;
  // The harness SDK and the tRPC declarations are built by two jobs, not by two
  // steps of one: neither build reads the other's output.
  assert.deepEqual(
    Object.keys(jobs).filter(name => name.startsWith('prepare')),
    [harnessProducer, trpcProducer],
    'the producers are separate jobs'
  );
  const producer = jobs[harnessProducer];
  assert.ok(producer, 'the harness producer exists');
  assert.equal(producer.needs, 'mobile-changes', 'the harness producer waits for change detection');
  assert.equal(producer.if, "needs.mobile-changes.outputs.mobile == 'true'");
  const producerSteps = producer.steps;
  const producerInstall = producerSteps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const actionIndex = producerSteps.findIndex(
    step => step.uses === './.github/actions/harness-sdk-build'
  );
  // Pick the artifact by name, not by position.
  const sdkUploads = producerSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === sdkArtifact
    );
  assert.equal(sdkUploads.length, 1, 'the harness producer uploads its build exactly once');
  const uploadIndex = sdkUploads[0].index;
  assert.ok(
    producerInstall >= 0 && actionIndex > producerInstall,
    'the harness producer builds after install'
  );
  assert.ok(uploadIndex > actionIndex, 'the harness producer uploads what it built');
  const upload = producerSteps[uploadIndex];
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'immutable upload pin');
  assert.equal(upload.with.name, sdkArtifact);
  assert.equal(upload.with.path, sdkDist, 'the artifact root is the dist directory');
  assert.equal(upload.with['if-no-files-found'], 'error', 'an empty build must fail');

  // `typecheck` and `lint` resolve the declarations as well, so they wait for
  // both producers. The unused-export check and the shards import only the
  // harness SDK build, so a declaration miss must not delay them.
  for (const [name, producers] of [
    ['mobile-typecheck', [harnessProducer, trpcProducer]],
    ['mobile-lint', [harnessProducer, trpcProducer]],
    ['check-unused', [harnessProducer]],
    ['mobile-test', [harnessProducer]],
  ]) {
    const job = jobs[name];
    const needs = [job.needs ?? []].flat();
    assert.ok(needs.includes('mobile-changes'), `${name} waits for change detection`);
    for (const candidate of [harnessProducer, trpcProducer]) {
      assert.equal(
        needs.includes(candidate),
        producers.includes(candidate),
        `${name} ${producers.includes(candidate) ? 'waits for' : 'does not wait for'} ${candidate}`
      );
    }
    const steps = job.steps;
    assert.deepEqual(
      steps
        .filter(step => step.uses === './.github/actions/harness-sdk-build')
        .map(step => step.name),
      [],
      `${name} never rebuilds the harness SDK`
    );
    assert.deepEqual(
      steps.filter(step => step.run === harnessBuild).map(step => step.name),
      [],
      `${name} never builds the harness SDK outside the action`
    );
    const installIndex = steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    // The consumer also downloads the tRPC declarations; pick this artifact by
    // name, not by position.
    const sdkDownloads = steps
      .map((step, index) => ({ step, index }))
      .filter(
        ({ step }) =>
          step.uses?.startsWith('actions/download-artifact@') && step.with?.name === sdkArtifact
      );
    assert.equal(sdkDownloads.length, 1, `${name} downloads the harness SDK build once`);
    const downloadIndex = sdkDownloads[0].index;
    assert.ok(
      installIndex >= 0 && downloadIndex > installIndex,
      `${name} downloads the build after install`
    );
    const download = steps[downloadIndex];
    assert.match(
      download.uses,
      /^actions\/download-artifact@[0-9a-f]{40}$/,
      'immutable download pin'
    );
    assert.equal(download.with.name, sdkArtifact, `${name} takes the shared artifact`);
    assert.equal(download.with.path, sdkDist, `${name} restores it where the build writes`);
  }

  // A failed build leaves the suite jobs skipped, and a skipped required check
  // passes, so the aggregator must carry each producer's failure.
  for (const requiredProducer of [harnessProducer, trpcProducer]) {
    assert.ok(
      [jobs['mobile-test-result'].needs].flat().includes(requiredProducer),
      `the mobile-test-result aggregator fails with a failed ${requiredProducer}`
    );
  }
});

// mobile-native-build needs the same single producer for a different reason:
// both platform jobs start together after the gate, so running the action in
// each made a dist cache miss pay the typia compile twice and raced both to
// save the one key. `prepare-harness-sdk` builds it once, and the macOS job
// downloads the Linux tree just as it restores the Linux cache entry today.
test('mobile-native-build builds the harness SDK once and both platform jobs download it', () => {
  const jobs = workflows['mobile-native-build.yml'].jobs;
  const actionUsers = Object.entries(jobs)
    .filter(([, job]) =>
      (job.steps ?? []).some(step => step.uses === './.github/actions/harness-sdk-build')
    )
    .map(([name]) => name);
  assert.deepEqual(actionUsers, [harnessProducer], 'only the producer builds the harness SDK');

  const producer = jobs[harnessProducer];
  assert.equal(producer.needs, 'gate', 'the producer waits for the gate it is skipped by');
  assert.equal(
    producer.if,
    "needs.gate.outputs.need_ios == 'true' || needs.gate.outputs.need_android == 'true'",
    'a run with every platform published must not pay a build for nobody'
  );
  const producerSteps = producer.steps;
  const producerInstall = producerSteps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const producerAction = producerSteps.findIndex(
    step => step.uses === './.github/actions/harness-sdk-build'
  );
  assert.ok(
    producerInstall >= 0 && producerAction > producerInstall,
    'the producer builds after the workspace install'
  );
  const sdkUploads = producerSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === sdkArtifact
    );
  assert.equal(sdkUploads.length, 1, 'the producer uploads its build exactly once');
  assert.ok(sdkUploads[0].index > producerAction, 'the producer uploads what it built');
  const upload = sdkUploads[0].step;
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'immutable upload pin');
  assert.equal(upload.with.path, sdkDist, 'the artifact root is the dist directory');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['if-no-files-found'], 'error', 'an empty build must fail');

  for (const name of ['ios', 'android']) {
    const job = jobs[name];
    assert.ok(
      [job.needs ?? []].flat().includes(harnessProducer),
      `${name} waits for the build it downloads`
    );
    const steps = job.steps;
    const installIndex = steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    assert.deepEqual(
      steps.filter(step => step.run === harnessBuild).map(step => step.name),
      [],
      `${name} never builds the harness SDK by hand`
    );
    const sdkDownloads = steps
      .map((step, index) => ({ step, index }))
      .filter(
        ({ step }) =>
          step.uses?.startsWith('actions/download-artifact@') && step.with?.name === sdkArtifact
      );
    assert.equal(sdkDownloads.length, 1, `${name} downloads the harness SDK build once`);
    const downloadIndex = sdkDownloads[0].index;
    assert.ok(
      installIndex >= 0 && downloadIndex > installIndex,
      `${name} downloads the build after install`
    );
    const download = sdkDownloads[0].step;
    assert.match(
      download.uses,
      /^actions\/download-artifact@[0-9a-f]{40}$/,
      'immutable download pin'
    );
    assert.equal(download.with.path, sdkDist, `${name} restores it where the build writes`);
    assert.equal(
      download.if,
      "steps.published.outputs.published != 'true'",
      `${name} still skips its whole build when another run published`
    );
  }
});

// The mobile checks resolve the tRPC declarations too, and one shared job gates
// them both, so both used to run the action: a cache miss compiled the
// declaration program twice and both jobs raced to save the one key.
// `prepare-trpc` builds it once and the checks download the tree.
const trpcAction = './.github/actions/trpc-declarations';
const trpcDist = 'packages/trpc/dist';
const trpcArtifact = 'trpc-declarations';

test('kilo-app CI builds the tRPC declarations once and both checks download them', () => {
  const jobs = workflows['kilo-app-ci.yml'].jobs;
  const actionUsers = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => step.uses === trpcAction))
    .map(([name]) => name);
  assert.deepEqual(actionUsers, [trpcProducer], 'only the declaration producer builds them');

  const producerSteps = jobs[trpcProducer].steps;
  const installIndex = producerSteps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const actionIndex = producerSteps.findIndex(step => step.uses === trpcAction);
  // Pick the artifact by name, not by position.
  const uploads = producerSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === trpcArtifact
    );
  assert.equal(uploads.length, 1, 'the producer uploads the declarations exactly once');
  assert.equal(
    jobs[trpcProducer].needs,
    'mobile-changes',
    'the declaration producer waits for change detection alone, not for the harness build'
  );
  assert.ok(installIndex >= 0 && actionIndex > installIndex, 'the producer builds after install');
  assert.ok(uploads[0].index > actionIndex, 'the producer uploads what it built');
  const upload = uploads[0].step;
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'immutable upload pin');
  assert.equal(upload.with.path, trpcDist, 'the artifact root is the dist directory');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['if-no-files-found'], 'error', 'an empty build must fail');

  for (const [name, run] of [
    ['mobile-typecheck', 'Typecheck'],
    ['mobile-lint', 'Lint'],
  ]) {
    const job = jobs[name];
    assert.ok([job.needs ?? []].flat().includes(trpcProducer), `${name} waits for the producer`);
    const steps = job.steps;
    assert.deepEqual(
      steps.filter(step => step.uses === trpcAction).map(step => step.name),
      [],
      `${name} never builds the declarations itself`
    );
    const downloads = steps
      .map((step, index) => ({ step, index }))
      .filter(
        ({ step }) =>
          step.uses?.startsWith('actions/download-artifact@') && step.with?.name === trpcArtifact
      );
    assert.equal(downloads.length, 1, `${name} downloads the declarations once`);
    assert.match(
      downloads[0].step.uses,
      /^actions\/download-artifact@[0-9a-f]{40}$/,
      'immutable download pin'
    );
    assert.equal(
      downloads[0].step.with.path,
      trpcDist,
      `${name} restores it where the build writes`
    );
    const jobInstall = steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    const jobRun = steps.findIndex(step => step.name === run);
    assert.ok(downloads[0].index > jobInstall, `${name} downloads after install`);
    assert.ok(downloads[0].index < jobRun, `${name} has the declarations before ${run}`);
  }

  // A failed declaration build leaves the checks skipped, and a skipped
  // required check passes, so the aggregator must carry the failure.
  assert.ok(
    [jobs['mobile-test-result'].needs].flat().includes(trpcProducer),
    'the mobile-test-result aggregator fails with the declaration build'
  );
});

// Every producer that builds the declarations for other jobs must install the
// same closure. The action's program is the whole input: a wider install links
// workspaces the build never reads, and a narrower one breaks the build. The
// jobs that build and then use the tree in one job install the whole workspace,
// so they are not producers and this test does not cover them.
test('kilo-app CI installs the closure the declaration action needs', () => {
  const install = (file, job) =>
    workflows[file].jobs[job].steps.find(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    )?.run;
  const producerInstall = install('kilo-app-ci.yml', trpcProducer);
  assert.match(
    producerInstall ?? '',
    /^pnpm install --frozen-lockfile --filter '@kilocode\/trpc\.\.\.' --filter 'web\.\.\.' --filter kilocode-monorepo$/,
    'the producer installs the declaration closure, not the whole workspace'
  );
  for (const [file, job] of [
    ['ci.yml', 'trpc-declarations'],
    ['mobile-native-build.yml', trpcProducer],
  ]) {
    assert.equal(
      producerInstall,
      install(file, job),
      `${file}'s ${job} builds the same declarations, so it installs the same closure`
    );
  }
});

// mobile-native-build needs the same producer for the same reason: both
// platform jobs start together after the gate, so running the action in each
// made a cache miss compile the declaration program twice and race both jobs to
// save the one key. `prepare-trpc` builds it once, and both platform jobs
// download the tree, as they already do for the harness SDK.
test('mobile-native-build builds the tRPC declarations once and both platform jobs download them', () => {
  const jobs = workflows['mobile-native-build.yml'].jobs;
  const actionUsers = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => step.uses === trpcAction))
    .map(([name]) => name);
  assert.deepEqual(actionUsers, [trpcProducer], 'only the producer builds the declarations');

  const producer = jobs[trpcProducer];
  assert.equal(producer.needs, 'gate', 'the producer waits for the gate it is skipped by');
  assert.equal(
    producer.if,
    "needs.gate.outputs.need_ios == 'true' || needs.gate.outputs.need_android == 'true'",
    'a run with every platform published must not pay a build for nobody'
  );
  const producerSteps = producer.steps;
  const installIndex = producerSteps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const actionIndex = producerSteps.findIndex(step => step.uses === trpcAction);
  assert.ok(installIndex >= 0 && actionIndex > installIndex, 'the producer builds after install');
  const uploads = producerSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === trpcArtifact
    );
  assert.equal(uploads.length, 1, 'the producer uploads the declarations exactly once');
  assert.ok(uploads[0].index > actionIndex, 'the producer uploads what it built');
  const upload = uploads[0].step;
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'immutable upload pin');
  assert.equal(upload.with.path, trpcDist, 'the artifact root is the dist directory');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['if-no-files-found'], 'error', 'an empty build must fail');

  for (const name of ['ios', 'android']) {
    const job = jobs[name];
    assert.ok(
      [job.needs ?? []].flat().includes(trpcProducer),
      `${name} waits for the build it downloads`
    );
    const steps = job.steps;
    assert.deepEqual(
      steps.filter(step => step.uses === trpcAction).map(step => step.name),
      [],
      `${name} never builds the declarations itself`
    );
    const downloads = steps
      .map((step, index) => ({ step, index }))
      .filter(
        ({ step }) =>
          step.uses?.startsWith('actions/download-artifact@') && step.with?.name === trpcArtifact
      );
    assert.equal(downloads.length, 1, `${name} downloads the declarations once`);
    assert.match(
      downloads[0].step.uses,
      /^actions\/download-artifact@[0-9a-f]{40}$/,
      'immutable download pin'
    );
    assert.equal(
      downloads[0].step.with.path,
      trpcDist,
      `${name} restores it where the build writes`
    );
    const jobInstall = steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    assert.ok(
      jobInstall >= 0 && downloads[0].index > jobInstall,
      `${name} downloads the declarations after install`
    );
    assert.equal(
      downloads[0].step.if,
      "steps.published.outputs.published != 'true'",
      `${name} still skips its whole build when another run published`
    );
  }
});

// The tRPC action gets the same guard as the harness SDK build action: a hit
// proves the key, not the tree.
test('the tRPC declarations action rebuilds a hit that misses an entry point', () => {
  const action = load(
    readFileSync(
      new URL('../.github/actions/trpc-declarations/action.yml', import.meta.url),
      'utf8'
    )
  );
  const steps = action.runs.steps;
  const cache = steps.find(step => step.name === 'Restore tRPC declarations');
  const restored = steps.find(step => step.name === 'Check the restored declarations');
  const build = steps.find(step => step.name === 'Build trpc types');
  assert.equal(cache.uses, 'actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7');
  assert.equal(cache.with.path, 'packages/trpc/dist');
  assert.ok(
    steps.indexOf(cache) < steps.indexOf(restored) &&
      steps.indexOf(restored) < steps.indexOf(build),
    'the check runs between the restore and the build'
  );
  assert.equal(restored.id, 'restored');
  assert.equal(restored.shell, 'bash');
  assert.equal(restored.if, undefined, 'the check runs on a miss too');
  for (const entry of ['packages/trpc/dist/index.d.ts', 'packages/trpc/dist/mobile.d.ts']) {
    assert.ok(restored.run.includes(entry), `the check requires ${entry}`);
  }
  assert.match(restored.run, /^usable='false'$/m);
  assert.match(restored.run, /echo "usable=\$usable" >> "\$GITHUB_OUTPUT"/m);
  const rebuild = "steps.restored.outputs.usable != 'true'";
  assert.equal(build.if, rebuild, 'the build gates on the check, not the raw cache hit');
  assert.doesNotMatch(build.if, /cache-hit/, 'the raw cache hit no longer gates the build');
});

test('the tRPC declarations action shares one dist entry across runner operating systems', () => {
  const action = load(
    readFileSync(
      new URL('../.github/actions/trpc-declarations/action.yml', import.meta.url),
      'utf8'
    )
  );
  const steps = action.runs.steps;
  const key = steps.find(step => step.name === 'Hash tRPC declaration inputs');
  const cache = steps.find(step => step.name === 'Restore tRPC declarations');
  assert.equal(key.run, 'node scripts/trpc-declaration-key.mjs >> "$GITHUB_OUTPUT"');
  assert.equal(cache.with.path, 'packages/trpc/dist');
  // The dist is a TypeScript declaration emit and actions/cache derives the same
  // version on Linux and macOS, so an OS prefix would only split one build into a
  // family per runner and leave the macOS jobs unable to hit an ubuntu save.
  assert.equal(cache.with.key, 'trpc-declarations-${{ steps.key.outputs.key }}');
  assert.equal(cache.with['restore-keys'], undefined, 'a partial restore would serve stale dist');
});

test('the harness SDK action shares one dist entry across runner operating systems', () => {
  const steps = harnessBuildAction.runs.steps;
  const key = steps.find(step => step.name === 'Hash harness SDK build inputs');
  const cache = steps.find(step => step.name === 'Restore harness SDK build');
  const restored = steps.find(step => step.name === 'Check the restored build');
  const plugins = steps.filter(step => step.uses === pluginCacheAction);
  const build = steps.find(step => step.name === 'Build harness SDK');
  const save = steps.find(step => step.name === 'Save harness SDK build');
  assert.equal(key.run, 'node scripts/harness-sdk-build-key.mjs >> "$GITHUB_OUTPUT"');
  // The dist cache is split: only a completed build saves, so a failed or
  // cancelled build cannot take the key with the tree it half wrote.
  assert.equal(cache.uses, 'actions/cache/restore@668228422ae6a00e4ad889ee87cd7109ec5666a7');
  assert.equal(cache.with.path, 'packages/harness-sdk/dist');
  // The dist is a TypeScript emit and actions/cache derives the same version on
  // Linux and macOS, so an OS prefix would only split one build into a family
  // per runner and leave the macOS jobs unable to hit an ubuntu save.
  const distKey = 'harness-sdk-build-${{ steps.key.outputs.key }}';
  assert.equal(cache.with.key, distKey);
  assert.equal(cache.with['restore-keys'], undefined, 'a partial restore would serve stale dist');
  // A hit alone is not a build: a restore missing the package entry rebuilds.
  assert.ok(
    steps.indexOf(cache) < steps.indexOf(restored) &&
      steps.indexOf(restored) < steps.indexOf(build),
    'the check runs between the restore and the build'
  );
  assert.equal(restored.id, 'restored');
  assert.equal(restored.shell, 'bash');
  assert.equal(restored.if, undefined, 'the check runs on a miss too');
  for (const entry of [
    'packages/harness-sdk/dist/index.js',
    'packages/harness-sdk/dist/index.d.ts',
  ]) {
    assert.ok(restored.run.includes(entry), `the check requires ${entry}`);
  }
  assert.match(restored.run, /^usable='false'$/m);
  assert.match(restored.run, /echo "usable=\$usable" >> "\$GITHUB_OUTPUT"/m);
  const rebuild = "steps.restored.outputs.usable != 'true'";
  assert.equal(build.run, harnessBuild);
  assert.equal(build.if, rebuild);
  assert.equal(save.uses, 'actions/cache/save@668228422ae6a00e4ad889ee87cd7109ec5666a7');
  assert.equal(save.if, rebuild, 'only a build that runs is saved');
  assert.equal(save.with.path, 'packages/harness-sdk/dist');
  assert.equal(save.with.key, distKey, 'the save writes the key the restore reads');
  assert.ok(steps.indexOf(build) < steps.indexOf(save), 'the save follows the build');
  // The typia transform takes minutes to compile, so the build's plugin cache
  // comes from the shared action and only when a build will run.
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].uses, pluginCacheAction);
  assert.equal(plugins[0].with, undefined);
  assert.equal(plugins[0].if, rebuild);
  assert.equal(plugins[0].id, 'plugins');
  // macOS has no ci.yml writer for its platform-scoped key, so this action
  // writes the macOS key itself, after the build that compiled the plugins.
  // The save requires the build path: a skipped restore leaves its outputs
  // empty, and a save keyed on them would write nothing.
  const macSave = steps.find(step => step.name === 'Save compiler plugins');
  assert.ok(macSave, 'the build action writes the macOS key');
  assert.equal(
    macSave.if,
    "runner.os == 'macOS' && steps.restored.outputs.usable != 'true' && steps.plugins.outputs.cache-hit != 'true'"
  );
  assert.equal(steps.indexOf(macSave), steps.length - 1);
});

// The plugin cache action owns the key material and the restore; it cannot
// save, because ttsc writes the plugins after the action runs.
test('the compiler plugin cache action restores under one plugin-scoped key', () => {
  const steps = pluginCacheActionYaml.runs.steps;
  const hash = steps.find(step => step.name === 'Hash compiler plugin inputs');
  const restore = steps.find(step => step.name === 'Restore compiler plugins');
  assert.equal(hash.run, 'node scripts/ttsc-plugin-key.mjs >> "$GITHUB_OUTPUT"');
  assert.equal(restore.uses, 'actions/cache/restore@668228422ae6a00e4ad889ee87cd7109ec5666a7');
  assert.equal(restore.with.path, pluginPath);
  // The whole-lockfile hash and the prefix restore key both crossed versions:
  // the key covers only the plugin's own closure, and a restore that misses it
  // compiles again rather than reusing another version's plugin.
  assert.equal(
    restore.with.key,
    '${{ runner.os }}-${{ runner.arch }}-ttsc-plugins-${{ steps.key.outputs.key }}'
  );
  assert.equal(
    restore.with['restore-keys'],
    undefined,
    'a partial restore would serve a plugin built from other versions'
  );
  assert.equal(
    steps.find(step => step.uses?.startsWith('actions/cache/save@')),
    undefined
  );
  assert.deepEqual(Object.keys(pluginCacheActionYaml.outputs ?? {}).sort(), ['cache-hit', 'key']);
  assert.equal(
    pluginCacheActionYaml.outputs['cache-hit'].value,
    '${{ steps.restore.outputs.cache-hit }}'
  );
  assert.equal(pluginCacheActionYaml.outputs.key.value, '${{ steps.key.outputs.key }}');
});

// One job compiles the tRPC declarations per commit. The typecheck and lint
// matrices both relied on the same cache key and started together, so a miss
// compiled the program twice and both jobs raced to save one key. The producer
// keeps the cache, and only the two trpc rows download its artifact: the web
// and packages typecheck rows and the lint-rest row must not wait for it.
test('one job builds the tRPC declarations and only the trpc rows download them', () => {
  const trpcAction = './.github/actions/trpc-declarations';
  const ci = workflows['ci.yml'];
  const producerName = 'trpc-declarations';
  const actionUsers = Object.entries(ci.jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => step.uses === trpcAction))
    .map(([name]) => name);
  assert.deepEqual(actionUsers, [producerName], 'only the producer builds the declarations');

  const producer = ci.jobs[producerName];
  assert.equal(producer.needs, 'changes');
  assert.equal(
    producer.if,
    "contains(fromJSON(needs.changes.outputs.typecheck_groups), 'trpc') || contains(fromJSON(needs.changes.outputs.lint_groups), 'trpc')",
    'a run that selects neither trpc row must not pay for the producer'
  );
  const producerInstall = producer.steps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const producerAction = producer.steps.findIndex(step => step.uses === trpcAction);
  assert.ok(producerInstall >= 0 && producerAction > producerInstall);
  const upload = producer.steps.find(step =>
    String(step.uses).startsWith('actions/upload-artifact@')
  );
  assert.equal(upload.with.name, 'trpc-declarations');
  assert.equal(upload.with.path, 'packages/trpc/dist');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['if-no-files-found'], 'error');

  // The rows that read no declarations depend on `changes` alone.
  for (const [name, matrix] of [
    ['typecheck-groups', 'typecheck_groups_non_trpc'],
    ['lint-groups', 'lint_groups_non_trpc'],
  ]) {
    const job = ci.jobs[name];
    assert.equal(job.needs, 'changes', `${name} must not wait for the producer`);
    assert.equal(
      job.if,
      `needs.changes.outputs.${matrix} != '[]'`,
      `${name} runs whenever its own list is non-empty`
    );
    assert.equal(
      job.strategy.matrix.group,
      `\${{ fromJSON(needs.changes.outputs.${matrix}) }}`,
      `${name} lists only the rows that need no declarations`
    );
    assert.deepEqual(
      job.steps.filter(step => String(step.uses).startsWith('actions/download-artifact@')),
      [],
      `${name} never downloads the declarations`
    );
    assert.deepEqual(
      job.steps.filter(step => step.uses === trpcAction),
      [],
      `${name} never builds the declarations itself`
    );
  }

  // A run that selects the trpc group still fails the required check when the
  // producer fails: the trpc rows always run and their download fails.
  for (const [name, guard, groupOutput, checkName, command] of [
    [
      'typecheck-trpc',
      "contains(fromJSON(needs.changes.outputs.typecheck_groups), 'trpc')",
      'typecheck_groups',
      'typecheck (trpc)',
      'scripts/typecheck-all.sh --group trpc',
    ],
    [
      'lint-trpc',
      "contains(fromJSON(needs.changes.outputs.lint_groups), 'trpc')",
      'lint_groups',
      'lint (trpc)',
      'scripts/lint-all.sh --group trpc',
    ],
  ]) {
    const job = ci.jobs[name];
    assert.deepEqual(job.needs, ['changes', producerName], `${name} waits for the producer`);
    assert.equal(
      job.if,
      `always() && needs.changes.result == 'success' && ${guard}`,
      `${name} runs even when the producer is skipped or failed`
    );
    assert.equal(job.name, checkName, `${name} keeps the check name of the row it replaced`);
    assert.deepEqual(
      job.steps.filter(step => step.uses === trpcAction),
      [],
      `${name} never builds the declarations itself`
    );
    const downloadIndex = job.steps.findIndex(step =>
      String(step.uses).startsWith('actions/download-artifact@')
    );
    const download = job.steps[downloadIndex];
    assert.equal(download.with.name, 'trpc-declarations');
    assert.equal(download.with.path, 'packages/trpc/dist');
    assert.equal(download.if, undefined, `${name} always needs the artifact`);
    const installIndex = job.steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    assert.ok(downloadIndex > installIndex, `${name} downloads after install`);
    const step = job.steps.find(candidate => candidate.run === command);
    assert.ok(step, `${name} runs ${command}`);
    assert.equal(step.env.KILO_AFFECTED, '${{ needs.changes.outputs.affected }}');
    assert.ok(
      ci.jobs.changes.outputs[groupOutput],
      `the producer and ${name} select themselves from ${groupOutput}`
    );
  }

  // The trpc typecheck row consumes the declarations, so its group script
  // skips its own build there.
  const typecheck = ci.jobs['typecheck-trpc'].steps.find(step =>
    (step.run ?? '').startsWith('scripts/typecheck-all.sh')
  );
  assert.equal(typecheck.env.KILO_TYPECHECK_TRPC_BUILT, '1');
  const otherTypecheck = ci.jobs['typecheck-groups'].steps.find(step =>
    (step.run ?? '').startsWith('scripts/typecheck-all.sh')
  );
  assert.equal(otherTypecheck.env.KILO_TYPECHECK_TRPC_BUILT, undefined);

  // The required aggregators wait for both halves, so a failed producer or a
  // failed trpc row fails the check instead of vanishing as a skipped job.
  assert.deepEqual(ci.jobs.typecheck.needs, ['changes', 'typecheck-groups', 'typecheck-trpc']);
  assert.deepEqual(ci.jobs.lint.needs, ['changes', 'lint-groups', 'lint-trpc']);
});

// Which rows run is one decision, and the affected detector owns it: it keeps
// the extension's own workflow as the single typecheck and lint for a change
// that only affects the extension.
test('the changes job takes both matrix group lists from the affected detector', () => {
  const step = ciJobs.changes.steps.find(candidate => candidate.id === 'affected');
  assert.match(
    step.run,
    /groups=\$\(node scripts\/affected-workspaces\.mjs --groups <<< "\$affected"\)/,
    'the groups come from the detector, not from a workflow-local projection'
  );
  assert.match(step.run, /echo "typecheck_groups=\$\(jq -c \.typecheck_groups <<< "\$groups"\)"/);
  assert.match(step.run, /echo "lint_groups=\$\(jq -c \.lint_groups <<< "\$groups"\)"/);
  // The trpc-only rows need the declarations, so the non-trpc matrices need a
  // list without them. The producer's `if` only sees its own selection unless
  // every list the rows read is derived from this one output.
  for (const list of ['typecheck_groups', 'lint_groups']) {
    assert.match(
      step.run,
      new RegExp(`echo "${list}_non_trpc=\\$\\{?${list}_non_trpc\\}?`),
      `the non-trpc ${list} matrix comes from this job's outputs`
    );
    assert.match(
      step.run,
      new RegExp(
        `${list}_non_trpc=\\$\\(jq -c \\x27\\[\\.` +
          `${list}\\[\\] \\| select\\(. != \\x22trpc\\x22\\)\\]\\x27`
      ),
      `the non-trpc ${list} list is derived from the producer's selection`
    );
  }
  assert.doesNotMatch(
    step.run,
    /\.full_checks \| index\("(typecheck|lint)"\) != null\) as \$all/,
    'the workflow must not compute the group lists itself'
  );
});

// A main push pays for the workspaces its pushed range can affect, like a pull
// request pays for its branch's diff. The merge queue supplies no base, so it
// keeps the full selection as the last gate before a merge; the detector turns
// a base that is not a commit in the checkout into the same full selection.
test('the affected detector selects from the pushed range on a main push', () => {
  const step = ciJobs.changes.steps.find(candidate => candidate.id === 'affected');
  assert.equal(
    step.env.BASE_SHA,
    "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event_name == 'push' && github.event.before || '' }}",
    'a pull request and a main push each select from their own base; the merge queue passes none'
  );
});

// The matrix step reuses the document the detector step published: dropping the
// env makes scripts/changed-workspaces.sh select the repository a second time.
test('the matrix step decides from the document the affected step published', () => {
  const step = ciJobs.changes.steps.find(candidate => candidate.id === 'workspaces');
  assert.equal(
    step.env.AFFECTED,
    '${{ steps.affected.outputs.affected }}',
    'the matrix step must receive the selection the detector step computed'
  );
  assert.match(
    step.run,
    /matrix=\$\(scripts\/changed-workspaces\.sh "\$\{excludes\[@\]\}" "\$\{includes\[@\]\}"\)/,
    'the matrix still comes from the matrix script'
  );
});

// The gating job reads the repository, not node_modules: only
// scripts/changed-dependencies.mjs imports a package (js-yaml), and the detector
// calls it only for a dependency input: a manifest, or a patch the closures
// carry. The install therefore follows a filter over exactly that set; an input
// the detector gained without the filter would run the detector without
// js-yaml.
test('the changes job installs the root project only for a dependency input', () => {
  const steps = ciJobs.changes.steps;
  const filter = steps.find(step => step.id === 'filter_resources');
  assert.ok(filter, 'changes: the dependency-input filter is missing');
  assert.deepEqual(
    Object.keys(load(filter.with.filters)),
    ['resources'],
    'the filter publishes one output that the install reads'
  );
  assert.deepEqual(
    load(filter.with.filters).resources,
    DEPENDENCY_INPUTS,
    'the filter matches the detector inputs exactly, in the glob syntax it reports'
  );
  const install = steps.find(step => step.name === 'Install root dependencies');
  assert.equal(
    install.if,
    "steps.filter_resources.outputs.resources == 'true' || steps.filter_resources_retry.outputs.resources == 'true' || steps.resources_base.outputs.manifests == 'true'",
    'the install runs on the filter answer, first attempt or retry, or the detector-base diff'
  );
  assert.ok(
    steps.indexOf(install) >
      steps.indexOf(steps.find(step => step.id === 'filter_resources_retry')),
    'the install reads an answer the filter already wrote'
  );
  // dorny/paths-filter answers from the pull request's merge-base diff and
  // scripts/affected-workspaces.mjs diffs the base tip, so on a branch that is
  // behind main their answers can disagree and only the detector's diff saves
  // the run. The check step must reuse the detector's base, ask the detector
  // which inputs those are (never hardcode them), and land before the install.
  const affected = steps.find(step => step.id === 'affected');
  const local = steps.find(step => step.id === 'resources_base');
  assert.ok(local, 'changes: the detector-base dependency-input check is missing');
  assert.equal(
    local.env.BASE_SHA,
    affected.env.BASE_SHA,
    'the check diffs the base the detector diffs, or the answers can drift'
  );
  assert.match(local.run, /module\.isDependencyInput/);
  assert.doesNotMatch(
    local.run,
    /pnpm-(lock|workspace)\.yaml|patches\//,
    'the input set stays in scripts/affected-workspaces.mjs'
  );
  assert.match(local.run, /echo "manifests=\$answer"/);
  assert.match(
    local.run,
    /if \[ "\$answer" != true \] && \[ "\$answer" != false \]; then[\s\S]*answer=true/,
    'an unreadable detector keeps the install instead of risking a detector without js-yaml'
  );
  assert.ok(
    steps.indexOf(install) > steps.indexOf(local),
    'the install reads an answer the check wrote'
  );
});

// The extension changes job is the serialized prelude of every extension CI
// run: `verify`, `build-firefox` and `e2e-chrome` all need it, so an install it
// does not need costs every run. It reads the repository for the same reason as
// the ci.yml job above, over the same detector set, so it carries one gate:
// these assertions compare the two step definitions, and a new detector input
// added to one gate without the other fails here.
test('the extension changes job carries the shared dependency-input install gate', () => {
  const steps = workflows['extension-ci.yml'].jobs.changes.steps;
  const shared = ciJobs.changes.steps;
  const sharedStep = id => shared.find(step => step.id === id);
  const step = id => steps.find(candidate => candidate.id === id);

  const filter = step('filter_resources');
  const retry = step('filter_resources_retry');
  const base = step('resources_base');
  assert.ok(filter, 'extension-ci changes: the dependency-input filter is missing');
  assert.ok(retry, 'extension-ci changes: the dependency-input filter retry is missing');
  assert.ok(base, 'extension-ci changes: the detector-base dependency-input check is missing');

  assert.equal(
    filter.with.filters,
    sharedStep('filter_resources').with.filters,
    'both changes jobs filter the same dependency inputs'
  );
  assert.equal(
    filter['continue-on-error'],
    sharedStep('filter_resources')['continue-on-error'],
    'the first attempt tolerates a transient failure'
  );
  assert.equal(
    retry.if,
    sharedStep('filter_resources_retry').if,
    'the retry runs only after a failed first attempt'
  );
  assert.equal(
    retry.with.filters,
    filter.with.filters,
    'the retry evaluates the same paths as the attempt it replaces'
  );
  assert.equal(
    retry['continue-on-error'],
    sharedStep('filter_resources_retry')['continue-on-error'],
    'the retry shares the shared changes job retry contract'
  );
  assert.equal(
    retry['continue-on-error'],
    undefined,
    'a persistent filter failure fails the job instead of installing nothing'
  );
  assert.equal(
    base.env.BASE_SHA,
    sharedStep('resources_base').env.BASE_SHA,
    'both changes jobs diff the base their detector diffs'
  );
  assert.equal(
    base.run,
    sharedStep('resources_base').run,
    'one detector-base check serves both jobs, so the input set stays in one place'
  );

  const install = steps.find(candidate => candidate.name === 'Install root dependencies');
  const sharedInstall = shared.find(candidate => candidate.name === 'Install root dependencies');
  assert.equal(
    install.run,
    sharedInstall.run,
    'the gate removes the install from the run, never changes what it installs'
  );
  assert.equal(
    install.if,
    sharedInstall.if,
    'the extension and the shared changes job gate the install on the same answers'
  );
  assert.ok(
    steps.indexOf(install) > steps.indexOf(retry) && steps.indexOf(install) > steps.indexOf(base),
    'the install reads answers both detections already wrote'
  );
  assert.ok(
    steps.indexOf(install) < steps.indexOf(step('workspaces')),
    'the detector that may need js-yaml runs after the install it can ask for'
  );
  assert.equal(
    workflows['extension-ci.yml'].jobs.changes.outputs.extension,
    "${{ steps.filter.outputs.extension == 'true' || steps.workspaces.outputs.extension == 'true' }}",
    'the gate leaves the job output that the three downstream jobs read'
  );
});

// The four shards run one Jest suite, and its roots are apps/web, the
// web-shared and db sources its config maps in, and apps/ai-gateway. A
// recursive workspace install links every other project for a step that reads
// none of them, so the install names those closures. A suite that starts
// reading another workspace widens the filter; it does not restore the full
// install, and the shard count and the test step stay as they are.
const webTestInstall =
  "pnpm install --frozen-lockfile --filter 'web...' --filter 'ai-gateway...' --filter kilocode-monorepo";

test('the web-test shards install the closure their Jest suite reads', () => {
  const job = ciJobs['web-test'];
  const install = job.steps.find(step => step.name === 'Install dependencies');
  assert.equal(install.run, webTestInstall, 'the shards install the suite closure');
  assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4], 'four shards still run');
  const run = job.steps.find(step => step.name === 'Run web tests');
  assert.equal(run.run, 'pnpm --filter web test --shard=${{ matrix.shard }}/4');
});

// The plugin files reach one check only: test-scripts runs
// `test:oxlint-plugins` over them. The web Jest suite, the web build and the
// cycle check read none of them, so the plugin path has its own filter pair and
// the shared filter that gates those three names no plugin file. A plugin path
// back in the shared filter would start four web-test shards, the production
// build and the cycle check for a change none of them reads.
const oxlintPluginPath = 'tools/oxlint/anti-slop/rules/no-runtime-typeof.ts';
const webBackendPath = 'apps/web/src/routers/active-sessions-router.ts';

test('a lint-plugin change runs the plugin suite without the web gates', () => {
  const filtersOf = id => {
    const step = ciJobs.changes.steps.find(candidate => candidate.id === id);
    assert.ok(step, `changes: the ${id} step is missing`);
    return load(step.with.filters);
  };
  const matches = (patterns, path) => patterns.some(pattern => posix.matchesGlob(path, pattern));

  const backend = filtersOf('filter').kilocode_backend;
  assert.deepEqual(
    filtersOf('filter_retry').kilocode_backend,
    backend,
    'the shared retry keeps the filters of the attempt it replaces'
  );
  assert.equal(
    matches(backend, webBackendPath),
    true,
    'a backend path still matches the shared filter'
  );
  assert.equal(matches(backend, oxlintPluginPath), false, 'the shared filter names no plugin path');

  const plugins = filtersOf('filter_oxlint').oxlint_plugins;
  assert.deepEqual(
    filtersOf('filter_oxlint_retry').oxlint_plugins,
    plugins,
    'the plugin retry keeps the filters of the attempt it replaces'
  );
  assert.equal(matches(plugins, oxlintPluginPath), true, 'the plugin pair detects a plugin change');
  assert.equal(matches(plugins, webBackendPath), false, 'the plugin pair detects nothing else');
  assert.equal(
    ciJobs.changes.outputs.oxlint_plugins,
    '${{ steps.filter_oxlint.outputs.oxlint_plugins || steps.filter_oxlint_retry.outputs.oxlint_plugins }}',
    'the plugin output falls back to its retry attempt'
  );

  assert.match(
    ciJobs['test-scripts'].if,
    /needs\.changes\.outputs\.oxlint_plugins == 'true'/,
    'test-scripts keeps the one check that reads those paths'
  );
  for (const job of ['web-test', 'build', 'dependency-cycle-check']) {
    assert.match(
      ciJobs[job].if,
      /needs\.changes\.outputs\.kilocode_backend == 'true'/,
      `${job}: gated on the shared filter alone, which names no plugin path`
    );
  }
});

// The account database job runs the root `drizzle` script, which executes
// drizzle-kit inside packages/db, and one session-sync suite whose workspace
// imports are @kilocode/db and @kilocode/worker-utils, both declared by the
// service. The install names those closures, and packages/db stays listed
// because the migrate step resolves drizzle-kit there. A step that starts
// reading another workspace widens the filter; it does not restore the full
// install.
const sessionSyncPostgresInstall =
  "pnpm install --frozen-lockfile --filter 'cloudflare-session-sync...' --filter '@kilocode/db...' --filter kilocode-monorepo";

test('the session-sync Postgres job installs the closure its steps read', () => {
  const job = ciJobs['session-sync-postgres'];
  const installs = job.steps.filter(step => /^pnpm\b.*\binstall\b/.test(step.run ?? ''));
  assert.deepEqual(
    installs.map(step => step.run),
    [sessionSyncPostgresInstall],
    'one install links the session-sync closure, the database closure and the root project'
  );
  const run = job.steps.find(step => step.name === 'Run session-sync account database tests');
  assert.equal(
    run.run,
    'NODE_ENV=development pnpm drizzle migrate && pnpm --filter cloudflare-session-sync test:postgres',
    'the migrate and suite commands are unchanged'
  );
});

// The wiring job reads the root project and executes Wrangler's real config
// parser from the usage-ingest closure, so one frozen install selects both. A
// second install step would resolve and link the same lockfile again on the
// same runner.
const wiringInstall =
  'pnpm install --frozen-lockfile --ignore-scripts --filter cloudflare-usage-ingest --filter kilocode-monorepo';

test('the ci-wiring job installs its closure in one pass', () => {
  const steps = ciJobs['ci-wiring'].steps;
  const installs = steps.filter(step => /^pnpm\b.*\binstall\b/.test(step.run ?? ''));
  assert.deepEqual(
    installs.map(step => step.run),
    [wiringInstall],
    'one install links the root project and the usage-ingest closure'
  );
  const installIndex = steps.indexOf(installs[0]);
  const relay = steps.findIndex(step =>
    /scripts\/deployment-workflows\.test\.mjs/.test(step.run ?? '')
  );
  assert.ok(
    relay > installIndex,
    'the relay regression runs after the install that links Wrangler'
  );
});

// The measured per-job install share of wall time keeps a narrowing above one
// tenth of the job it saves: the mobile-test shards, `mobile-lint` and
// `check-unused` clear that bar, and `mobile-typecheck`'s sample run does not,
// so it keeps the whole workspace for now. When a measurement moves a job over
// the bar, name it here; a step that starts importing another workspace widens
// its job's filter, and no job restores the full install to hide an undeclared
// import. Dependency postinstalls stay enabled across these jobs.
const appClosureInstall =
  "pnpm install --frozen-lockfile --filter 'kilo-app...' --filter kilocode-monorepo";

test('the kilo-app CI consumers install the app closure', () => {
  // The producer jobs keep their own wider (or whole-workspace) closures, and
  // `mobile-typecheck` keeps the whole workspace until its measured saving
  // clears the bar; every other install in this workflow is the app's.
  const consumerJobs = Object.entries(kiloAppJobs)
    .filter(
      ([name, job]) =>
        !name.startsWith('prepare') &&
        name !== 'mobile-typecheck' &&
        (job.steps ?? []).some(step => /^pnpm install --frozen-lockfile\b/.test(step.run ?? ''))
    )
    .map(([name]) => name);
  for (const name of consumerJobs) {
    const install = kiloAppJobs[name].steps.find(step => step.name === 'Install dependencies');
    assert.equal(
      install.run,
      appClosureInstall,
      `${name} installs the app closure, not the whole workspace`
    );
  }
  assert.deepEqual(
    consumerJobs,
    ['mobile-lint', 'check-unused', 'mobile-test'],
    'the app closure covers the measured consumer installs and leaves the others alone'
  );
});

// The extension's unit suite runs in extension-ci.yml for a pull request and a
// main push, and that workflow has no merge_queue trigger: the ci.yml row is the
// merge-queue gate, and it installs and tests nothing on the events the other
// workflow covers. The row stays in the matrix either way, so the check still
// reports and the required `test` passes while its steps are skipped.
test('the extension matrix row defers to extension CI outside the merge queue', () => {
  const gate = "matrix.workspace.name != 'kilo-extension' || github.event_name == 'merge_group'";
  const steps = ciJobs['workspace-tests'].steps;
  for (const name of ['Install dependencies', 'Run tests']) {
    assert.equal(
      steps.find(step => step.name === name).if,
      gate,
      `workspace-tests: ${name} must run for the extension only in the merge queue`
    );
  }
  const matrix = ciJobs.changes.steps.find(step => step.id === 'workspaces');
  assert.doesNotMatch(
    matrix.run,
    /--exclude apps\/extension/,
    'the merge queue has no other extension gate, so the row stays in the matrix'
  );

  const extensionCi = load(
    readFileSync(new URL('../.github/workflows/extension-ci.yml', import.meta.url), 'utf8')
  );
  assert.deepEqual(
    Object.keys(extensionCi.on).sort(),
    ['pull_request', 'push'],
    'extension CI covers the events the ci.yml row now defers on'
  );
  const verify = extensionCi.jobs.verify.steps.find(
    step => step.run === `pnpm --filter ${extension.name} verify`
  );
  assert.ok(verify, 'extension CI runs the extension verify script');
  const commands = extension.scripts.verify.split('&&').map(command => command.trim());
  assert.ok(
    commands.includes('pnpm run test'),
    'the retained job runs the same unit tests the skipped step did'
  );
  for (const command of ['pnpm run typecheck', 'pnpm run lint']) {
    assert.ok(commands.includes(command), `the retained job keeps ${command}`);
  }
});

// A selection document from scripts/affected-workspaces.mjs, as the root script
// reads it.
const selection = (overrides = {}) => ({
  base: 'base',
  full: false,
  reasons: [],
  full_checks: [],
  dirs: [],
  packages: [],
  test_only_dirs: [],
  test_only_packages: [],
  test_only_files: [],
  ...overrides,
});

function runTypecheck(
  t,
  {
    root = false,
    changes = '',
    group = '',
    buildExit = 0,
    checkExit = 0,
    built = '',
    affected = selection(),
    selectionExit = 0,
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'apps/extension'), { recursive: true });
  writeFileSync(join(dir, 'apps/extension/package.json'), JSON.stringify(extension));
  mkdirSync(join(dir, 'apps/mobile'), { recursive: true });
  writeFileSync(
    join(dir, 'apps/mobile/package.json'),
    JSON.stringify({
      name: 'kilo-app',
      dependencies: { '@kilocode/harness-sdk': 'workspace:*', '@kilocode/trpc': 'workspace:*' },
    })
  );
  mkdirSync(join(dir, 'services/cloud-agent-next'), { recursive: true });
  writeFileSync(
    join(dir, 'services/cloud-agent-next/package.json'),
    JSON.stringify({ name: 'cloud-agent-next', private: true })
  );
  // The detector decides the selection, and its own suite covers that decision.
  // Here it answers with the document the test supplies and records the base it
  // was asked for.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts/affected-workspaces.mjs'),
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.COMMAND_LOG, 'node scripts/affected-workspaces.mjs ' + process.argv.slice(2).join(' ') + '\\n');\n" +
      "if (process.env.SELECTION_EXIT !== '0') process.exit(Number(process.env.SELECTION_EXIT));\n" +
      'process.stdout.write(process.env.SELECTION);\n'
  );
  const cli = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const name = basename(process.argv[1]);
const changes = process.env.CHANGES.split(',');
if (name === 'git') {
  if (args[0] === 'merge-base') console.log('base');
  else if (args.includes('packages/trpc/src/**') && changes.includes('trpc')) console.log('packages/trpc/src/index.ts');
  else if (args.includes('packages/harness-sdk/tsconfig.build.json') && changes.includes('harness-build')) console.log('packages/harness-sdk/tsconfig.build.json');
  else if (args.includes('pnpm-workspace.yaml') && changes.includes('workspace')) console.log('pnpm-workspace.yaml');
} else if (name === 'pnpm' && args[0] === '-r') {
  appendFileSync(process.env.COMMAND_LOG, name + ' ' + args.join(' ') + '\\n');
  const result = spawnSync('sh', ['-c', process.env.EXTENSION_TYPECHECK], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else {
  appendFileSync(process.env.COMMAND_LOG, name + ' ' + args.join(' ') + '\\n');
  if (name === 'pnpm' && args.includes('@kilocode/trpc')) process.exit(Number(process.env.BUILD_EXIT));
  if (name === 'tsc') process.exit(Number(process.env.CHECK_EXIT));
}
`;
  for (const name of ['pnpm', 'tsgo', 'tsc', 'git']) {
    writeFileSync(join(bin, name), cli, { mode: 0o755 });
  }
  const log = join(dir, 'commands.log');
  writeFileSync(log, '');
  const result = spawnSync(
    root ? 'bash' : 'sh',
    root
      ? [rootScript, ...(group ? ['--group', group] : changes ? ['--changes-only'] : [])]
      : ['-c', extension.scripts.typecheck],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        KILO_TYPECHECK_TRPC_BUILT: built,
        EXTENSION_TYPECHECK: extension.scripts.typecheck,
        CHANGES: changes,
        KILO_AFFECTED: JSON.stringify(affected),
        SELECTION: JSON.stringify(affected),
        SELECTION_EXIT: String(selectionExit),
        BUILD_EXIT: String(buildExit),
        CHECK_EXIT: String(checkExit),
        COMMAND_LOG: log,
      },
    }
  );
  return {
    status: result.status,
    commands: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
  };
}

test('standalone extension checks build tRPC before compiling', t => {
  const result = runTypecheck(t);
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, ['pnpm --filter @kilocode/trpc build', 'tsc --noEmit']);
});

test('extension checks reuse tRPC built by the root script', t => {
  const result = runTypecheck(t, { built: '1' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, ['tsc --noEmit']);
});

test('a failed standalone tRPC build prevents extension compilation', t => {
  const result = runTypecheck(t, { buildExit: 7 });
  assert.equal(result.status, 7);
  assert.deepEqual(result.commands, ['pnpm --filter @kilocode/trpc build']);
});

test('extension compiler errors still fail when tRPC is already built', t => {
  assert.equal(runTypecheck(t, { built: '1', checkExit: 9 }).status, 9);
});

const workspaceFilters = '--filter !kilocode-monorepo --filter !web --filter !@kilocode/trpc';
const fullWorkspaceTypecheck = `pnpm -r ${workspaceFilters} run typecheck`;
const trpcBuild = 'pnpm --filter @kilocode/trpc run build';
const selectedTypecheck = names =>
  `pnpm -r ${names.map(name => `--filter ${name}`).join(' ')} ${workspaceFilters} run typecheck`;
const detectorCall = 'node scripts/affected-workspaces.mjs base --worktree';
const workspaceRuns = result => result.commands.filter(command => command.startsWith('pnpm -r'));

test('a full run builds each prerequisite once and checks every workspace', t => {
  const result = runTypecheck(t, { root: true });
  const count = name =>
    result.commands.filter(command => command.startsWith(`pnpm --filter ${name} `)).length;
  assert.equal(result.status, 0);
  assert.equal(count('@kilocode/trpc'), 1);
  assert.equal(count('@kilocode/harness-sdk'), 1);
  assert.deepEqual(workspaceRuns(result), [fullWorkspaceTypecheck]);
  assert.equal(result.commands.at(-1), 'tsc --noEmit');
});

test('a failed root tRPC build stops the typecheck', t => {
  const result = runTypecheck(t, { root: true, buildExit: 7 });
  assert.equal(result.status, 7);
  assert.deepEqual(result.commands, [trpcBuild]);
});

// The detector owns the selection, and a run that cannot get one must not check
// less than a full run.
test('a failed selection runs the full typecheck', t => {
  const result = runTypecheck(t, { root: true, changes: 'scoped', selectionExit: 1 });
  assert.equal(result.status, 0);
  assert.deepEqual(workspaceRuns(result), [fullWorkspaceTypecheck]);
  assert.deepEqual(
    result.commands.filter(command => command === trpcBuild),
    [trpcBuild]
  );
});

// A change to the workspace membership list can alter the type surface across
// packages, and the detector does not attribute it.
test('a pnpm-workspace.yaml change runs the full typecheck without selecting', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'workspace',
    affected: selection({ packages: ['ai-gateway'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(workspaceRuns(result), [fullWorkspaceTypecheck]);
  assert.deepEqual(
    result.commands.filter(command => command.startsWith('node scripts/')),
    []
  );
});

// The detector reports a full typecheck for a change to this script, because the
// script decides what every other workspace check runs. Every workspace is then
// checked, so both prerequisite builds must run even though the document names no
// directory.
test('a change to this script checks every workspace and builds its prerequisites', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'scoped',
    affected: selection({ full_checks: ['typecheck'] }),
  });
  assert.equal(result.status, 0);
  assert.ok(result.commands.includes(detectorCall));
  assert.deepEqual(workspaceRuns(result), [fullWorkspaceTypecheck]);
  assert.deepEqual(
    result.commands.filter(command => command === trpcBuild),
    [trpcBuild]
  );
  assert.deepEqual(
    result.commands.filter(command => command === harnessBuild),
    [harnessBuild]
  );
});

// A change reaches the workspaces it reads from and the workspaces that read it.
// The document names both, and one filter per name keeps the run on that set.
test('a changes-only run checks the packages the detector selects, readers included', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'scoped',
    affected: selection({
      dirs: ['apps/ai-gateway', 'apps/web', 'packages/usage-queue', 'packages/web-shared'],
      packages: ['@kilocode/usage-queue', '@kilocode/web-shared', 'ai-gateway', 'web'],
    }),
  });
  assert.equal(result.status, 0);
  assert.ok(result.commands.includes(detectorCall));
  assert.deepEqual(workspaceRuns(result), [
    selectedTypecheck(['@kilocode/usage-queue', '@kilocode/web-shared', 'ai-gateway']),
  ]);
});

// apps/web and scripts/web-env are root programs, and step 1 builds trpc: a
// selection that names only those adds no workspace run.
test('a changes-only run skips the workspace check when the root programs cover it', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'scoped',
    affected: selection({
      dirs: ['apps/web', 'packages/trpc'],
      packages: ['@kilocode/trpc', 'web'],
    }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(workspaceRuns(result), []);
});

// apps/extension and kilo-app compile against the tRPC declarations, and kilo-app
// against the harness SDK dist: those builds must run when the selection checks a
// reader, even when the package's own sources did not change.
test('a changes-only run builds the declarations a checked workspace reads', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'scoped',
    affected: selection({ dirs: ['apps/mobile'], packages: ['kilo-app'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.commands.filter(command => command === trpcBuild),
    [trpcBuild]
  );
  assert.deepEqual(
    result.commands.filter(command => command === harnessBuild),
    [harnessBuild]
  );
  assert.deepEqual(workspaceRuns(result), [selectedTypecheck(['kilo-app'])]);
});

test('a changes-only run skips both builds when no checked workspace reads them', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'scoped',
    affected: selection({ dirs: ['apps/ai-gateway'], packages: ['ai-gateway'] }),
  });
  assert.equal(result.status, 0);
  assert.equal(result.commands.includes(trpcBuild), false);
  assert.equal(result.commands.includes(harnessBuild), false);
});

test('a changes-only run rebuilds trpc when its source changed', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'trpc',
    affected: selection({ dirs: ['apps/extension'], packages: ['kilo-extension'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.commands.filter(command => command === trpcBuild),
    [trpcBuild]
  );
  assert.deepEqual(workspaceRuns(result), [selectedTypecheck(['kilo-extension'])]);
});

// The build the predicate guards is `ttsc -p tsconfig.build.json`, so a change
// to that file must force the rebuild: the dist of another build configuration
// does not hold the program the new one describes, and apps/mobile typechecks
// against it.
test('a changes-only run rebuilds the harness SDK when its build config changed', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'harness-build',
    affected: selection({ packages: ['ai-gateway'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.commands.filter(command => command === harnessBuild),
    [harnessBuild],
    'a skipped build leaves the dist of the previous build configuration in place'
  );
});

// The groups read the same document: `full` decides a check of every workspace,
// and a package name decides which packages a group checks.
test('a group checks every workspace when the selection is a full check', t => {
  const result = runTypecheck(t, {
    root: true,
    group: 'packages',
    affected: selection({ full: true }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(workspaceRuns(result), [
    `pnpm -r ${workspaceFilters} --filter !@kilocode/storybook --filter !kilo-app --filter !kilo-extension run typecheck`,
  ]);
});

test('a group typechecks the packages the selection names', t => {
  const result = runTypecheck(t, {
    root: true,
    group: 'packages',
    affected: selection({ packages: ['ai-gateway', 'web', '@kilocode/storybook'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(workspaceRuns(result), ['pnpm -r --filter ai-gateway run typecheck']);
});

// A document that names no package leaves the group with nothing to check; an
// empty filter name would select every workspace instead.
test('a group with an empty selection checks nothing', t => {
  const result = runTypecheck(t, {
    root: true,
    group: 'packages',
    affected: selection({ packages: [] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, []);
});

test('the web group checks its programs when the selection names them', t => {
  const result = runTypecheck(t, {
    root: true,
    group: 'web',
    affected: selection({ packages: ['@kilocode/storybook', 'web'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, [
    'tsgo --noEmit -p apps/web/tsconfig.json --incremental false',
    'tsgo --noEmit -p scripts/web-env/tsconfig.json',
    'pnpm --filter @kilocode/storybook run typecheck',
  ]);
});

test('the web group stays out of a selection that names neither program', t => {
  const result = runTypecheck(t, {
    root: true,
    group: 'web',
    affected: selection({ packages: ['ai-gateway'] }),
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, []);
});
// `pnpm-workspace.yaml` lists workspaces that sit inside another workspace
// (services/cloud-agent-next/wrapper is one). Both the full and the affected
// group runs select members with `pnpm -r ... run typecheck`, which starts
// every selected member's own script, so a member script that also starts
// another member's typecheck compiles that member twice per run.
const workspaces = (() => {
  const patterns = load(
    readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')
  ).packages;
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const parent = posix.dirname(pattern);
    for (const entry of readdirSync(new URL(`../${parent}/`, import.meta.url))) {
      const dir = posix.join(parent, entry);
      if (existsSync(new URL(`../${dir}/package.json`, import.meta.url))) dirs.push(dir);
    }
  }
  return dirs.map(dir => ({
    dir,
    manifest: JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8')),
  }));
})();

const workspaceDirByName = new Map(workspaces.map(({ dir, manifest }) => [manifest.name, dir]));
const manifestByDir = new Map(workspaces.map(({ dir, manifest }) => [dir, manifest]));

// The workspace members one script of `dir` starts with `pnpm ... <verb>`.
function scriptTargets(dir, script, verb) {
  const targets = new Set();
  for (const [command] of script.matchAll(/pnpm\s[^&|;\n]*/g)) {
    const verbRan = command
      .trim()
      .split(/\s+/)
      .some(token => token.replace(/[),;]+$/, '') === verb);
    if (!verbRan) continue;
    for (const [, flag, quoted] of command.matchAll(
      /(-C|--dir|--filter|-F)(?:=|\s+)('[^']*'|"[^"]*"|\S+)/g
    )) {
      const value = quoted.replace(/^['"]|['"]$/g, '').replace(/\.\.\.$/, '');
      const target =
        flag === '-C' || flag === '--dir'
          ? posix.normalize(posix.join(dir, value))
          : workspaceDirByName.get(value);
      if (target) targets.add(target);
    }
  }
  return [...targets];
}

const typecheckedWorkspaces = (dir, script) => scriptTargets(dir, script, 'typecheck');

test('no workspace typecheck starts another workspace typecheck', () => {
  const duplicates = [];
  for (const { dir, manifest } of workspaces) {
    const script = manifest.scripts?.typecheck;
    if (!script) continue;
    for (const target of typecheckedWorkspaces(dir, script)) {
      if (target !== dir) duplicates.push(`${manifest.name} also typechecks ${target}`);
    }
  }
  assert.deepEqual(duplicates, [], 'a recursive workspace run already typechecks every member');
});

// A typecheck that also builds another workspace makes every caller pay for a
// program the checked sources may never read: apps/web rebuilt the tRPC
// declarations although it declares no dependency on them.
test('no workspace typecheck builds a workspace it does not depend on', () => {
  const undeclared = [];
  for (const { dir, manifest } of workspaces) {
    const script = manifest.scripts?.typecheck;
    if (!script) continue;
    const declared = new Set(
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap(
        field => Object.keys(manifest[field] ?? {})
      )
    );
    for (const target of scriptTargets(dir, script, 'build')) {
      const dependency = manifestByDir.get(target)?.name;
      if (target !== dir && dependency && !declared.has(dependency)) {
        undeclared.push(`${manifest.name} builds ${dependency}, which it does not depend on`);
      }
    }
  }
  assert.deepEqual(undeclared, []);
});

// Dropping the nested call leaves a standalone `typecheck` covering only this
// program, so the service keeps a script that covers both for a caller outside
// the recursive workspace run.
test('cloud-agent-next keeps a standalone typecheck that covers its wrapper', () => {
  const service = workspaces.find(({ manifest }) => manifest.name === 'cloud-agent-next');
  const wrapper = workspaces.find(
    ({ manifest }) => manifest.name === '@kilocode/cloud-agent-wrapper'
  );
  assert.ok(service && wrapper);
  assert.equal(wrapper.dir, posix.join(service.dir, 'wrapper'));
  const combined = Object.entries(service.manifest.scripts)
    .filter(([, script]) => /\btsgo\b|\btsc\b/.test(script))
    .filter(([, script]) => typecheckedWorkspaces(service.dir, script).includes(wrapper.dir))
    .map(([name]) => name);
  assert.notEqual(combined.length, 0, 'a script typechecks the service and its wrapper');
});
