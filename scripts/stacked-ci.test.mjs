import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

import { wiringCommand } from './ci-wiring-suites.mjs';

const rootPath = '.github/workflows/ci.yml';
const mobilePath = '.github/workflows/kilo-app-ci.yml';
const checkPath = 'scripts/stacked-ci.test.mjs';
// The path families the mobile change-detection grep must recognise. The PR
// admission and the `push` trigger carry no filter, so this grep is the only
// thing that gates the suite; a dropped or mistyped family silently reports
// `mobile=false` and skips every required check, so it must be pinned.
const mobilePathFragments = [
  /apps\/mobile\//,
  /packages\/trpc\//,
  /apps\/web\/src\/routers\//,
  /packages\/app-shared\//,
  /packages\/event-service\//,
  /packages\/notifications\//,
  /packages\/cloud-agent-sdk\//,
  // The app's oxlint configs load the plugins from tools/oxlint, so a plugin
  // change must run the app's own lint and i18n checks.
  /tools\/oxlint\//,
  /pnpm-lock\\?\.yaml/,
  /kilo-app-ci\\?\.yml/,
  // Path-qualified: a bare `/ci\\?\.yml/` also matches the `kilo-app-ci.yml`
  // alternative above, so dropping the root-workflow family would go unnoticed.
  /\.github\/workflows\/ci\\?\.yml/,
  /stacked-ci\\?\.test\\?\.mjs/,
];

function readWorkflows() {
  return [rootPath, mobilePath].map(path =>
    load(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
  );
}

function admits(workflow, event, base, files) {
  if (!(event in workflow.on)) return false;
  const trigger = workflow.on[event] ?? {};
  if (trigger.branches && !trigger.branches.some(pattern => matchesGlob(base, pattern)))
    return false;
  if (trigger['branches-ignore']?.some(pattern => matchesGlob(base, pattern))) return false;
  if (
    trigger.paths &&
    !files.some(file => trigger.paths.some(pattern => matchesGlob(file, pattern)))
  )
    return false;
  return (
    !trigger['paths-ignore'] ||
    files.some(file => !trigger['paths-ignore'].some(pattern => matchesGlob(file, pattern)))
  );
}

// The job runs exactly when a path its suites read changed. A run that changes
// no workflow, action, script or manifest cannot change what this check decides,
// and the required `test` fan-in passes a skipped job, so the gate itself must be
// exact: a wider skip, or a different output, would drop the admission silently.
const wiringGate = { needs: 'changes', if: "needs.changes.outputs.wiring == 'true'" };

function validateCheck(workflow, jobName) {
  const job = workflow.jobs[jobName];
  assert.deepEqual(
    { needs: job.needs, if: job.if },
    wiringGate,
    `${jobName}: the check must run exactly when the changes job reports a wiring change`
  );
  assert.equal(job['continue-on-error'], undefined, `${jobName}: check failure must fail the job`);
  const steps = job.steps;
  // One step runs the shared suite command verbatim, so splitting the suite
  // back into per-file steps, or dropping or reordering a suite, fails here.
  const checks = steps.filter(step => step.run === wiringCommand);
  assert.equal(checks.length, 1, `${jobName}: run the check exactly once`);
  const step = checks[0];
  assert.equal(step.if, undefined, `${jobName}: check step must be unconditional`);
  assert.equal(
    step['continue-on-error'],
    undefined,
    `${jobName}: check failure must not be ignored`
  );
  assert.equal(
    step['working-directory'] ??
      job.defaults?.run?.['working-directory'] ??
      workflow.defaults?.run?.['working-directory'] ??
      '.',
    '.',
    `${jobName}: check must run from the repository root`
  );
  const installIndex = steps.findIndex(item => /\bpnpm\b.*\binstall\b/.test(item.run ?? ''));
  const checkIndex = steps.indexOf(step);
  assert.ok(installIndex >= 0 && installIndex < checkIndex, `${jobName}: install before the check`);
  // No job waits for the check job, so only the required `test` fan-in makes
  // a broken admission block the merge.
  assert.ok(
    [workflow.jobs.test?.needs ?? []].flat().includes(jobName),
    `${jobName}: the required test job must need the check job`
  );
}

function validateMobileDetect(mobile) {
  const detect = mobile.jobs['mobile-changes'].steps.find(item => item.id === 'detect');
  for (const fragment of mobilePathFragments) {
    assert.match(
      detect.run ?? '',
      fragment,
      `mobile change-detection step must recognise ${fragment}`
    );
  }
}

function validate(root, mobile) {
  for (const workflow of [root, mobile]) {
    assert.ok('pull_request' in workflow.on, 'pull_request must be enabled');
    const trigger = workflow.on.pull_request ?? {};
    assert.equal(trigger.branches, undefined, 'pull_request must admit every base');
    assert.equal(trigger['branches-ignore'], undefined, 'pull_request must not exclude bases');
    assert.deepEqual(workflow.on.push.branches, ['main'], 'push must remain main-only');
    assert.equal(workflow.on.push['branches-ignore'], undefined);
  }
  assert.equal(root.on.pull_request?.paths, undefined, 'root admission must not filter paths');
  assert.equal(root.on.pull_request?.['paths-ignore'], undefined);
  assert.equal(
    mobile.on.pull_request?.paths,
    undefined,
    'mobile admission must not filter paths: a required suite check must report on every PR'
  );
  assert.equal(mobile.on.pull_request?.['paths-ignore'], undefined);
  assert.deepEqual(root.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.deepEqual(mobile.permissions, { contents: 'read' });
  assert.ok('workflow_call' in mobile.on, 'mobile release caller must remain enabled');
  assert.equal(
    mobile.on.push.paths,
    undefined,
    'push must not filter by path: the required suite checks must report on every main push'
  );
  assert.equal(mobile.on.push['paths-ignore'], undefined);
  validateCheck(root, 'ci-wiring');
  validateMobileDetect(mobile);
}

test('both live workflows validate triggers and unconditional check invocations', () => {
  validate(...readWorkflows());
});

for (const base of ['main', 'stack/level-one', 'arbitrary/parent-42']) {
  for (const file of [rootPath, mobilePath, checkPath, 'apps/mobile/src/app/_layout.tsx']) {
    test(`isolated ${file} admits both workflows on ${base}`, () => {
      for (const workflow of readWorkflows()) {
        assert.equal(admits(workflow, 'pull_request', base, [file]), true);
      }
    });
  }
}

test('mobile admits every PR and every main push, stays main-only on push', () => {
  const [root, mobile] = readWorkflows();
  for (const file of [mobilePath, 'apps/mobile/src/app/_layout.tsx', 'README.md']) {
    assert.equal(admits(mobile, 'pull_request', 'stack/parent', [file]), true);
    assert.equal(admits(mobile, 'push', 'main', [file]), true);
    assert.equal(admits(mobile, 'push', 'stack/parent', [file]), false);
  }
  assert.equal(admits(root, 'push', 'stack/parent', [rootPath]), false);
});

test('mobile catches an isolated root main-only regression on a stacked base', () => {
  const [root, mobile] = readWorkflows();
  root.on.pull_request = { branches: ['main'] };
  assert.equal(admits(root, 'pull_request', 'stack/parent', [rootPath]), false);
  assert.equal(admits(mobile, 'pull_request', 'stack/parent', [rootPath]), true);
  assert.throws(() => validate(root, mobile), /pull_request must admit every base/);
});

for (const [index, jobName] of [[0, 'ci-wiring']]) {
  for (const defect of [
    'missing',
    'conditional-step',
    'conditional-job',
    'ungated',
    'ignored',
    'directory',
    'before-install',
    'not-required',
  ]) {
    test(`${jobName} rejects a ${defect} check`, () => {
      const workflows = readWorkflows();
      const job = workflows[index].jobs[jobName];
      const checkIndex = job.steps.findIndex(step => step.run === wiringCommand);
      const check = job.steps[checkIndex];
      if (defect === 'missing') job.steps.splice(checkIndex, 1);
      if (defect === 'conditional-step') check.if = 'false';
      if (defect === 'conditional-job') job.if = 'false';
      if (defect === 'ungated') {
        delete job.if;
        delete job.needs;
      }
      if (defect === 'ignored') check['continue-on-error'] = true;
      if (defect === 'directory') job.defaults = { run: { 'working-directory': 'apps/mobile' } };
      if (defect === 'before-install') job.steps.unshift(...job.steps.splice(checkIndex, 1));
      if (defect === 'not-required') {
        const test = workflows[index].jobs.test;
        test.needs = test.needs.filter(need => need !== jobName);
      }
      assert.throws(() => validate(...workflows), assert.AssertionError);
    });
  }
}

test('mobile change detection pins the root workflow path family', () => {
  const workflows = readWorkflows();
  const detect = workflows[1].jobs['mobile-changes'].steps.find(step => step.id === 'detect');
  // The root-workflow family must be pinned by its own path: a bare `ci.yml`
  // fragment also matches the `kilo-app-ci.yml` alternative, so its removal
  // would otherwise pass.
  detect.run = detect.run.replace('|^\\.github/workflows/ci\\.yml$', '');
  assert.throws(() => validate(...workflows), /must recognise/);
});

// Only a change whose whole changed-path set is under tools/oxlint skips the
// shards and the typecheck. A missed skip costs runner minutes; a skip that also
// covers an app path would report success without executing the suite, and a
// release consumes that run as its proof for the commit.
const lintOnlyCondition =
  "needs.mobile-changes.outputs.mobile == 'true' && needs.mobile-changes.outputs.lint_only != 'true'";

// Reads the `key=value` lines GitHub collects from a step's `$GITHUB_OUTPUT`.
function readDetectOutput(output) {
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => line.split('='))
  );
}

// Runs the detector's own shell against fixture change sets. `git` answers the
// diffs and `node` answers the workspace selection, so the assertions read the
// outputs GitHub receives instead of a paraphrase of the step.
function runDetect(files, { base = 'resolved' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-app-detect-'));
  try {
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  rev-parse)',
        '    [ "$2" = "--verify" ] && [ "$DETECT_BASE" = "absent" ] && exit 1',
        '    exit 0',
        '    ;;',
        '  diff)',
        `    [ -n "$DETECT_FILES" ] && printf '%s\\n' "$DETECT_FILES"`,
        '    exit 0',
        '    ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    writeFileSync(
      join(bin, 'node'),
      '#!/bin/sh\necho \'{"full":false,"packages":[],"test_only_packages":[]}\'\n',
      { mode: 0o755 }
    );
    const output = join(work, 'output');
    writeFileSync(output, '');
    const detect = readWorkflows()[1].jobs['mobile-changes'].steps.find(
      step => step.id === 'detect'
    );
    execFileSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', detect.run.replace(/\$\{\{[^}]*\}\}/g, 'fixture')],
      {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          DETECT_BASE: base,
          DETECT_FILES: files.join('\n'),
        },
      }
    );
    return readDetectOutput(output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// A stub `git` answers a fixed file list, so it cannot show how git reports a
// rename. This harness commits `baseFiles` in a real repository, tags that
// commit `fixture` (the literal every `${{ ... }}` is replaced with), applies
// the `change` callback as a second commit, and runs the same detector shell
// with the real git on PATH.
function runDetectInRepo(baseFiles, change) {
  const work = mkdtempSync(join(tmpdir(), 'kilo-app-detect-repo-'));
  try {
    const repo = join(work, 'repo');
    mkdirSync(repo);
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    const write = path => {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), '// fixture\n');
    };
    git(['init', '--quiet', '--initial-branch=main']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'fixture']);
    for (const path of baseFiles) write(path);
    git(['add', '--all']);
    git(['commit', '--quiet', '--message', 'base']);
    git(['tag', 'fixture']);
    change({ git, write });
    git(['add', '--all']);
    git(['commit', '--quiet', '--message', 'change']);
    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'node'),
      '#!/bin/sh\necho \'{"full":false,"packages":[],"test_only_packages":[]}\'\n',
      { mode: 0o755 }
    );
    const output = join(work, 'output');
    writeFileSync(output, '');
    const detect = readWorkflows()[1].jobs['mobile-changes'].steps.find(
      step => step.id === 'detect'
    );
    execFileSync(
      'bash',
      ['-e', '-o', 'pipefail', '-c', detect.run.replace(/\$\{\{[^}]*\}\}/g, 'fixture')],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output },
      }
    );
    return readDetectOutput(output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const [name, files, expected] of [
  [
    'a lint plugin alone',
    ['tools/oxlint/anti-slop/index.ts'],
    { mobile: 'true', lint_only: 'true' },
  ],
  [
    'several lint plugins',
    ['tools/oxlint/anti-slop/index.ts', 'tools/oxlint/anti-slop/index.test.ts'],
    { mobile: 'true', lint_only: 'true' },
  ],
  [
    'a lint plugin with an app path',
    ['tools/oxlint/anti-slop/index.ts', 'apps/mobile/vitest.config.ts'],
    { mobile: 'true', lint_only: 'false' },
  ],
  ['an app path alone', ['apps/mobile/vitest.config.ts'], { mobile: 'true', lint_only: 'false' }],
  // The plugin branch writes `mobile=true` before the workspace selection runs,
  // so a plugin change that carries no app path still runs the app's lint.
  [
    'a lint plugin with an unrelated path',
    ['tools/oxlint/anti-slop/index.ts', 'README.md'],
    { mobile: 'true', lint_only: 'false' },
  ],
  ['this workflow alone', [mobilePath], { mobile: 'true', lint_only: 'false' }],
  ['an unrelated path alone', ['README.md'], { mobile: 'false', lint_only: 'false' }],
  ['no changed path', [], { mobile: 'false', lint_only: 'false' }],
]) {
  test(`mobile change detection publishes ${JSON.stringify(expected)} for ${name}`, () => {
    assert.deepEqual(runDetect(files), expected);
  });
}

test('mobile change detection runs the suite when the base commit is unknown', () => {
  assert.deepEqual(runDetect(['tools/oxlint/anti-slop/index.ts'], { base: 'absent' }), {
    mobile: 'true',
    lint_only: 'false',
  });
});

// Rename detection reports only the destination, so a move out of an app path
// into tools/oxlint would list one path, read as lint-only, and stand the
// shards and the typecheck down after an app source file was removed. The step
// diffs with `--no-renames`, which lists the deleted path as well.
test('mobile change detection keeps a move out of an app path out of lint-only', () => {
  assert.deepEqual(
    runDetectInRepo(['apps/mobile/src/gone.ts', 'tools/oxlint/plugin/index.ts'], ({ git }) => {
      git(['mv', 'apps/mobile/src/gone.ts', 'tools/oxlint/plugin/moved.ts']);
    }),
    { mobile: 'true', lint_only: 'false' }
  );
});

test('mobile change detection stays lint-only for a rename inside tools/oxlint', () => {
  assert.deepEqual(
    runDetectInRepo(['tools/oxlint/plugin/index.ts'], ({ git }) => {
      git(['mv', 'tools/oxlint/plugin/index.ts', 'tools/oxlint/plugin/entry.ts']);
    }),
    { mobile: 'true', lint_only: 'true' }
  );
});

test('only the shards and the typecheck skip a lint-only change', () => {
  const mobile = readWorkflows()[1];
  assert.equal(
    mobile.jobs['mobile-changes'].outputs.lint_only,
    '${{ steps.detect.outputs.lint_only }}',
    'the detection job must publish lint_only, or the gates below silently stop applying'
  );
  for (const name of ['mobile-test', 'mobile-typecheck']) {
    assert.equal(
      mobile.jobs[name].if,
      lintOnlyCondition,
      `${name} must skip exactly a lint-only change`
    );
  }
  for (const name of [
    'prepare-harness-sdk',
    'prepare-trpc',
    'mobile-lint',
    'i18n-leftover',
    'check-unused',
  ]) {
    assert.equal(
      mobile.jobs[name].if,
      "needs.mobile-changes.outputs.mobile == 'true'",
      `${name} must keep running for a lint-only change`
    );
  }
  assert.equal(
    mobile.jobs['mobile-test-result'].if,
    '${{ !cancelled() }}',
    'the required context must report whatever the shards did'
  );
});
