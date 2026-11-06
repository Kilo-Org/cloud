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

const workflows = Object.fromEntries(
  ['ci.yml', 'kilo-app-ci.yml', 'mobile-native-build.yml', 'explorer-ios-release.yml'].map(file => [
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
const web = JSON.parse(readFileSync(new URL('../apps/web/package.json', import.meta.url), 'utf8'));
const rootScript = fileURLToPath(new URL('./typecheck-all.sh', import.meta.url));
const harnessBuild = 'pnpm --filter @kilocode/harness-sdk run build';
const pluginCacheAction = './.github/actions/ttsc-plugin-cache';
const pluginPath = 'node_modules/.cache/ttsc/plugins';
// The step each plugin saver's save must follow.
const jobRun = new Map([
  ['ci.yml:harness-sdk', 'pnpm --filter @kilocode/harness-sdk check:ci'],
  ['ci.yml:workspace-tests', 'pnpm --filter ${{ matrix.workspace.name }} test'],
]);
const ciJobs = workflows['ci.yml'].jobs;
const pnpmCleanup = fileURLToPath(
  new URL('../.github/actions/pnpm-store/cleanup/cleanup.cjs', import.meta.url)
);

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
    ['ci.yml:mobile-diagram-host', 'extension-ci.yml:e2e-chrome', 'setup-smoke.yml:setup-smoke'],
    'every Chromium install in a live workflow is covered'
  );
});

for (const [file, name, command, condition] of [
  ['ci.yml', 'typecheck-groups', 'scripts/typecheck-all.sh --group ${{ matrix.group }}'],
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
  for (const [file, workflow] of Object.entries(workflows)) {
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const saversHere = steps.filter(step => step.uses?.startsWith('actions/cache/save@'));
      for (const save of saversHere) {
        assert.equal(save.uses, 'actions/cache/save@668228422ae6a00e4ad889ee87cd7109ec5666a7');
        assert.ok(
          (save.if ?? '').includes("steps.plugins.outputs.cache-hit != 'true'"),
          `${file}:${name} saves only what its own restore missed`
        );
        assert.equal(save.with.path, pluginPath);
        assert.equal(
          save.with.key,
          '${{ runner.os }}-${{ runner.arch }}-ttsc-plugins-${{ steps.plugins.outputs.key }}',
          `${file}:${name} saves under the key its restore read`
        );
        savers.push(`${file}:${name}`);
      }
      const restore = steps.find(step => step.uses === pluginCacheAction);
      if (restore) {
        // The save must follow the compilation: an inline save inside a
        // restore action would fire before ttsc wrote the plugins.
        if (saversHere.length > 0) {
          const saveIndex = steps.indexOf(saversHere.at(-1));
          const runIndex = steps.findIndex(step => step.run === jobRun.get(`${file}:${name}`));
          assert.ok(restore.id, `${file}:${name} must expose the plugin restore to its save`);
          assert.ok(saveIndex > runIndex, `${file}:${name} saves after its run compiles`);
        } else {
          assert.equal(restore.with, undefined, `${file}:${name} restores only`);
        }
      }
    }
  }
  // Each selection path has one saver: the dedicated harness-sdk job when the
  // packages/harness-sdk filter selected it, and the workspace-tests row
  // otherwise (whose matrix then carries the harness-sdk work).
  assert.deepEqual(savers, ['ci.yml:harness-sdk', 'ci.yml:workspace-tests']);
  assert.equal(
    ciJobs['workspace-tests'].steps.find(step => step.uses?.startsWith('actions/cache/save@')).if,
    "matrix.workspace.name == '@kilocode/harness-sdk' && steps.plugins.outputs.cache-hit != 'true' && needs.changes.outputs.harness_sdk != 'true'",
    'the two savers must not both save in one run'
  );
});

const harnessBuildGuards = [
  [
    'ci.yml',
    'lint-groups',
    "matrix.group == 'trpc' && contains(fromJSON(needs.changes.outputs.affected).full_checks, 'lint')",
  ],
  ...['ios', 'android'].map(name => [
    'mobile-native-build.yml',
    name,
    "steps.published.outputs.published != 'true'",
  ]),
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

// The mobile suite needs one harness SDK build, not one per job: the build
// resolves the SDK's whole program and, on a miss, compiles the typia
// transform. Eleven jobs did that concurrently, and actions/cache saves at the
// end of a job, so the eight shards could not hit each other's save. The shared
// `prepare` job builds once and every suite job downloads the result.
const sdkDist = 'packages/harness-sdk/dist';
const sdkArtifact = 'harness-sdk-dist';

test('kilo-app CI builds the harness SDK once and every suite downloads it', () => {
  const jobs = workflows['kilo-app-ci.yml'].jobs;
  const prepare = jobs.prepare;
  assert.ok(prepare, 'the shared build job exists');
  assert.equal(prepare.needs, 'mobile-changes', 'the shared build waits for change detection');
  assert.equal(prepare.if, "needs.mobile-changes.outputs.mobile == 'true'");
  const prepareSteps = prepare.steps;
  const prepareInstall = prepareSteps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const actionIndex = prepareSteps.findIndex(
    step => step.uses === './.github/actions/harness-sdk-build'
  );
  // prepare uploads two artifacts; pick this one by name, not by position.
  const sdkUploads = prepareSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === sdkArtifact
    );
  assert.equal(sdkUploads.length, 1, 'prepare uploads the harness SDK build exactly once');
  const uploadIndex = sdkUploads[0].index;
  assert.ok(prepareInstall >= 0 && actionIndex > prepareInstall, 'prepare builds after install');
  assert.ok(uploadIndex > actionIndex, 'prepare uploads what it built');
  const upload = prepareSteps[uploadIndex];
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'immutable upload pin');
  assert.equal(upload.with.name, sdkArtifact);
  assert.equal(upload.with.path, sdkDist, 'the artifact root is the dist directory');
  assert.equal(upload.with['if-no-files-found'], 'error', 'an empty build must fail');

  for (const name of ['typecheck', 'lint', 'check-unused', 'mobile-test']) {
    const job = jobs[name];
    assert.ok([job.needs ?? []].flat().includes('prepare'), `${name} waits for the build`);
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
  // passes, so the aggregator must carry the failure.
  assert.ok(
    [jobs.test.needs].flat().includes('prepare'),
    'the required test job fails with the shared build'
  );
});

// The mobile checks resolve the tRPC declarations too, and `prepare` gates them
// both, so both used to run the action: a cache miss compiled the declaration
// program twice and both jobs raced to save the one key. `prepare` builds it
// once and the checks download the tree.
const trpcAction = './.github/actions/trpc-declarations';
const trpcDist = 'packages/trpc/dist';
const trpcArtifact = 'trpc-declarations';

test('kilo-app CI builds the tRPC declarations once and both checks download them', () => {
  const jobs = workflows['kilo-app-ci.yml'].jobs;
  const actionUsers = Object.entries(jobs)
    .filter(([, job]) => (job.steps ?? []).some(step => step.uses === trpcAction))
    .map(([name]) => name);
  assert.deepEqual(actionUsers, ['prepare'], 'only the shared job builds the declarations');

  const prepareSteps = jobs.prepare.steps;
  const installIndex = prepareSteps.findIndex(step =>
    /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
  );
  const actionIndex = prepareSteps.findIndex(step => step.uses === trpcAction);
  // `prepare` uploads two artifacts; pick this one by name, not by position.
  const uploads = prepareSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step }) =>
        step.uses?.startsWith('actions/upload-artifact@') && step.with?.name === trpcArtifact
    );
  assert.equal(uploads.length, 1, 'prepare uploads the declarations exactly once');
  assert.ok(installIndex >= 0 && actionIndex > installIndex, 'prepare builds after install');
  assert.ok(uploads[0].index > actionIndex, 'prepare uploads what it built');
  const upload = uploads[0].step;
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, 'immutable upload pin');
  assert.equal(upload.with.path, trpcDist, 'the artifact root is the dist directory');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['if-no-files-found'], 'error', 'an empty build must fail');

  for (const [name, run] of [
    ['typecheck', 'Typecheck'],
    ['lint', 'Lint'],
  ]) {
    const job = jobs[name];
    assert.ok([job.needs ?? []].flat().includes('prepare'), `${name} waits for the producer`);
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
    [jobs.test.needs].flat().includes('prepare'),
    'the required test job fails with the declaration build'
  );
});

test('the harness SDK action restores dist and builds only on a miss', () => {
  const steps = harnessBuildAction.runs.steps;
  const key = steps.find(step => step.name === 'Hash harness SDK build inputs');
  const cache = steps.find(step => step.name === 'Restore harness SDK build');
  const plugins = steps.filter(step => step.uses === pluginCacheAction);
  const build = steps.find(step => step.name === 'Build harness SDK');
  assert.equal(key.run, 'node scripts/harness-sdk-build-key.mjs >> "$GITHUB_OUTPUT"');
  assert.equal(cache.uses, 'actions/cache@668228422ae6a00e4ad889ee87cd7109ec5666a7');
  assert.equal(cache.with.path, 'packages/harness-sdk/dist');
  assert.equal(cache.with.key, '${{ runner.os }}-harness-sdk-build-${{ steps.key.outputs.key }}');
  assert.equal(cache.with['restore-keys'], undefined, 'a partial restore would serve stale dist');
  assert.equal(build.run, harnessBuild);
  assert.equal(build.if, "steps.cache.outputs.cache-hit != 'true'");
  // The typia transform takes minutes to compile, so the build's plugin cache
  // comes from the shared action and only when a build will run. The build
  // restores only: the workspace-tests row owns the save.
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].uses, pluginCacheAction);
  assert.equal(plugins[0].with, undefined);
  assert.equal(plugins[0].if, "steps.cache.outputs.cache-hit != 'true'");
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
// keeps the cache and every consumer downloads its artifact.
test('one job builds the tRPC declarations and both matrices download them', () => {
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

  for (const [name, guard] of [
    ['typecheck-groups', "matrix.group == 'trpc'"],
    ['lint-groups', "matrix.group == 'trpc'"],
  ]) {
    const job = ci.jobs[name];
    assert.deepEqual(job.needs, ['changes', producerName], `${name} waits for the producer`);
    assert.match(
      job.if,
      /^always\(\) && needs\.changes\.result == 'success' && needs\.changes\.outputs\./,
      `${name} runs even when the producer is skipped or failed`
    );
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
    assert.equal(download.if, guard);
    const installIndex = job.steps.findIndex(step =>
      /^pnpm install --frozen-lockfile\b/.test(step.run ?? '')
    );
    assert.ok(downloadIndex > installIndex, `${name} downloads after install`);
  }

  // The trpc typecheck row consumes the declarations, so its group script and
  // apps/web's typecheck skip their own build there.
  const typecheck = ci.jobs['typecheck-groups'].steps.find(step =>
    (step.run ?? '').startsWith('scripts/typecheck-all.sh')
  );
  assert.equal(
    typecheck.env.KILO_TYPECHECK_TRPC_BUILT,
    "${{ matrix.group == 'trpc' && '1' || '' }}"
  );

  // The required aggregators keep their needs; a failed download fails the
  // group they already wait for.
  assert.deepEqual(ci.jobs.typecheck.needs, ['changes', 'typecheck-groups']);
  assert.deepEqual(ci.jobs.lint.needs, ['changes', 'lint-groups']);
});

function runTypecheck(
  t,
  {
    root = false,
    changes = '',
    buildExit = 0,
    checkExit = 0,
    built = '',
    selected = '',
    script = extension.scripts.typecheck,
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'node_modules/.bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(dir, 'apps/extension'), { recursive: true });
  writeFileSync(join(dir, 'apps/extension/package.json'), JSON.stringify(extension));
  mkdirSync(join(dir, 'services/cloud-agent-next'), { recursive: true });
  writeFileSync(
    join(dir, 'services/cloud-agent-next/package.json'),
    JSON.stringify({ name: 'cloud-agent-next', private: true })
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
  else if (args.includes('pnpm-workspace.yaml') && changes.includes('workspace')) console.log('pnpm-workspace.yaml');
  else if (args.includes('*.ts') && changes.includes('cloud-agent-next')) console.log('services/cloud-agent-next/src/shared/protocol.ts');
  else if (args.includes('*.ts')) console.log('apps/extension/package.json');
} else if (name === 'pnpm' && args[0] === 'ls') {
  appendFileSync(process.env.COMMAND_LOG, name + ' ' + args.join(' ') + '\\n');
  const selected = process.env.SELECTED.split(',').filter(Boolean);
  console.log(JSON.stringify(selected.map(entry => ({ name: entry }))));
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
    root ? [rootScript, ...(changes ? ['--changes-only'] : [])] : ['-c', script],
    {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        KILO_TYPECHECK_TRPC_BUILT: built,
        EXTENSION_TYPECHECK: extension.scripts.typecheck,
        CHANGES: changes,
        SELECTED: selected,
        BUILD_EXIT: String(buildExit),
        CHECK_EXIT: String(checkExit),
        COMMAND_LOG: log,
      },
    }
  );
  return { status: result.status, commands: readFileSync(log, 'utf8').trim().split('\n') };
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

// apps/web typechecks against the built declarations the same way: CI hands
// them over as an artifact, so the flag must stop the script rebuilding them.
test('web checks reuse tRPC built by the producer job', t => {
  const tsgo = 'tsgo --noEmit --checkers 1 --tsBuildInfoFile .tsbuildinfo/tsgo.tsbuildinfo';
  const reused = runTypecheck(t, { script: web.scripts.typecheck, built: '1' });
  assert.equal(reused.status, 0);
  assert.deepEqual(reused.commands, [tsgo]);

  const standalone = runTypecheck(t, { script: web.scripts.typecheck });
  assert.equal(standalone.status, 0);
  assert.deepEqual(standalone.commands, ['pnpm --filter @kilocode/trpc run build', tsgo]);

  const failedBuild = runTypecheck(t, { script: web.scripts.typecheck, buildExit: 7 });
  assert.equal(failedBuild.status, 7);
  assert.deepEqual(failedBuild.commands, ['pnpm --filter @kilocode/trpc run build']);
});

const workspaceFilters = '--filter !kilocode-monorepo --filter !web --filter !@kilocode/trpc';
const fullWorkspaceTypecheck = `pnpm -r ${workspaceFilters} run typecheck`;
const extensionTypecheck = `pnpm -r --filter ${extension.name}... ${workspaceFilters} run typecheck`;

for (const [changes, harnessBuilds, workspaceTypecheck] of [
  ['', 1, fullWorkspaceTypecheck],
  ['trpc', 0, extensionTypecheck],
  ['extension', 0, extensionTypecheck],
  ['workspace', 1, fullWorkspaceTypecheck],
  ['trpc,workspace', 1, fullWorkspaceTypecheck],
]) {
  test(`root ${changes || 'full'} typecheck builds each prerequisite once and checks the extension`, t => {
    const result = runTypecheck(t, { root: true, changes });
    const count = name =>
      result.commands.filter(command => command.startsWith(`pnpm --filter ${name} `)).length;
    assert.equal(result.status, 0);
    assert.equal(count('@kilocode/trpc'), 1);
    assert.equal(count('@kilocode/harness-sdk'), harnessBuilds);
    assert.deepEqual(
      result.commands.filter(command => command.startsWith('pnpm -r')),
      [workspaceTypecheck]
    );
    assert.equal(result.commands.at(-1), 'tsc --noEmit');
  });
}

test('a failed root tRPC build stops the typecheck', t => {
  const result = runTypecheck(t, { root: true, buildExit: 7 });
  assert.equal(result.status, 7);
  assert.deepEqual(result.commands, ['pnpm --filter @kilocode/trpc run build']);
});

// The wrapper compiles the service's own shared sources (its tsconfig includes
// ../src/shared), which a package filter does not follow. A changes-only run
// selects the wrapper whenever the service lands in the selection, once.
test('a changes-only run selects the wrapper when the service is selected', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'cloud-agent-next',
    selected: 'cloud-agent-next',
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.commands.filter(command => command.startsWith('pnpm -r')),
    [
      `pnpm -r --filter cloud-agent-next... --filter @kilocode/cloud-agent-wrapper ${workspaceFilters} run typecheck`,
    ]
  );
});

test('a changes-only run leaves the wrapper out when the service is not selected', t => {
  const result = runTypecheck(t, {
    root: true,
    changes: 'cloud-agent-next',
    selected: '@kilocode/worker-utils',
  });
  assert.equal(result.status, 0);
  assert.deepEqual(
    result.commands.filter(command => command.startsWith('pnpm -r')),
    [`pnpm -r --filter cloud-agent-next... ${workspaceFilters} run typecheck`]
  );
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

// The workspace members whose `typecheck` one script of `dir` starts.
function typecheckedWorkspaces(dir, script) {
  const targets = new Set();
  for (const [command] of script.matchAll(/pnpm\s[^&|;\n]*\brun\s+typecheck\b/g)) {
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
