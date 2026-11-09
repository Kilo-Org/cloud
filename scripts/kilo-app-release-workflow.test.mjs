import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

const workflowPath = '.github/workflows/kilo-app-release.yml';
const ciWorkflowPath = '.github/workflows/kilo-app-ci.yml';

function readWorkflow() {
  return load(readFileSync(new URL(`../${workflowPath}`, import.meta.url), 'utf8'));
}

function step(workflow, jobName, id) {
  return workflow.jobs[jobName].steps.find(item => item.id === id);
}

const mobilePackagePath = 'apps/mobile/package.json';
const easConfigPath = 'apps/mobile/eas.json';
const lockfilePath = 'pnpm-lock.yaml';

function readJson(rel) {
  return JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
}

function readLockfile() {
  return load(readFileSync(new URL(`../${lockfilePath}`, import.meta.url), 'utf8'));
}

// A build or a submission runs the EAS CLI the workspace installs, so the
// version recorded in the lockfile is the version that drives it. The manifest,
// eas.json, the lockfile and the workflow all have to name that same tool.
function validateEasCli(workflow, mobilePackage, easConfig, lockfile) {
  const declared = mobilePackage.devDependencies?.['eas-cli'];
  assert.match(
    declared ?? '',
    /^\d+\.\d+\.\d+$/,
    'eas-cli must be an exact development dependency'
  );
  assert.equal(
    easConfig.cli?.version,
    declared,
    'eas.json must select the CLI version the workspace declares'
  );

  // A frozen install refuses a manifest the graph does not carry, so the
  // recorded specifier has to be the exact version and the resolution has to
  // be that same release, not a peer-suffixed variant of another one.
  const recorded = lockfile.importers?.['apps/mobile']?.devDependencies?.['eas-cli'];
  assert.equal(
    recorded?.specifier,
    declared,
    'the lockfile must record the exact CLI version the manifest declares'
  );
  assert.equal(
    recorded?.version?.split('(')[0],
    declared,
    'the lockfile must resolve the CLI version the manifest declares'
  );
  assert.ok(
    lockfile.packages?.[`eas-cli@${declared}`],
    'the lockfile must resolve the CLI package the manifest declares'
  );

  for (const [name, command] of Object.entries(mobilePackage.scripts ?? {})) {
    if (!/\beas\b/.test(command)) continue;
    assert.equal(
      command.split(/\s+/)[0],
      'eas',
      `mobile script ${name} must run the workspace eas binary`
    );
  }

  const lines = Object.values(workflow.jobs)
    .flatMap(job => job.steps ?? [])
    .flatMap(item => (item.run ?? '').split('\n'))
    .filter(line => /\beas(?:-cli\b| (?:env:|build|submit)\b)/.test(line))
    .filter(line => !/^\s*echo\b/.test(line));
  assert.ok(lines.length > 0, 'the workflow must run the EAS CLI');
  for (const line of lines) {
    assert.match(
      line,
      /\bpnpm exec eas (?:env:|build|submit)\b/,
      `the workflow must run the installed CLI: ${line.trim()}`
    );
    // A step may nest one call inside another, as the build does inside
    // env:exec, so every call on the line has to name the installed binary.
    assert.doesNotMatch(
      line.replace(/\bpnpm exec eas (?=env:|build|submit)/g, ''),
      /\b(?:pnpx\s+)?eas(?:-cli)?\b/,
      `every EAS CLI call must run the installed binary: ${line.trim()}`
    );
  }
}

function validate(workflow) {
  // Trigger: the hourly run resumes a held release; push stays main-only.
  assert.deepEqual(workflow.on.push?.branches, ['main'], 'push must remain main-only');
  assert.equal(workflow.on.schedule?.length, 1, 'exactly one scheduled run must resume a hold');
  assert.match(workflow.on.schedule[0].cron, /^\S+ \S+ \S+ \S+ \S+$/, 'schedule must carry a cron');

  const checkChanges = workflow.jobs['check-changes'];
  const check = step(workflow, 'check-changes', 'check');

  // The changelog commit this workflow pushes re-triggers it, and the tag marks
  // the pre-changelog commit: without the exclusion every release starts the next.
  const diffLine = check.run.split('\n').find(line => line.includes('git diff --name-only'));
  assert.ok(diffLine, 'check-changes: the change detection diff is missing');
  assert.match(
    diffLine,
    /\(exclude\)apps\/mobile\/CHANGELOG\.md/,
    'change detection must exclude apps/mobile/CHANGELOG.md'
  );

  // LAST_TAG feeds the notes range, so a dispatch must compute it too.
  const lastTagIndex = check.run.indexOf('LAST_TAG=$(git tag');
  const dispatchIndex = check.run.indexOf('workflow_dispatch');
  assert.ok(
    lastTagIndex >= 0 && lastTagIndex < dispatchIndex,
    'LAST_TAG must be computed before the manual override'
  );
  assert.match(check.run, /version=\$VERSION/, 'the check step must print the submitted version');

  // The cap and the notes are the job outputs the downstream jobs and the
  // changelog job consume.
  assert.equal(checkChanges.outputs.allowed, '${{ steps.cap.outputs.allowed }}');
  assert.equal(checkChanges.outputs.version, '${{ steps.check.outputs.version }}');
  assert.equal(checkChanges.outputs.notes, '${{ steps.notes.outputs.notes }}');

  const notes = step(workflow, 'check-changes', 'notes');
  assert.ok(notes, 'check-changes: the notes step (id notes) is missing');
  assert.match(
    notes.run,
    /kilo-app-release-notes\.mjs body/,
    'the notes step must run the body subcommand'
  );
  assert.match(
    notes.run,
    /notes<<NOTES_EOF/,
    'the notes must reach the changelog job as a heredoc output'
  );

  const cap = step(workflow, 'check-changes', 'cap');
  assert.ok(cap, 'check-changes: the cap step (id cap) is missing');
  assert.match(
    cap.run,
    /kilo-app-release-upload-cap\.mjs --cap 10(?!\d)/,
    'the cap step must run the upload-cap script with --cap 10'
  );
  assert.match(
    cap.run,
    /--prefix kilo-app-upload\//,
    'the cap must count the iOS upload markers, not the release tags'
  );
  assert.match(cap.run, /\^allowed=/, 'the cap step must read the allowed= line');
  assert.match(
    cap.run,
    /allowed=\$ALLOWED" >> "\$GITHUB_OUTPUT"/,
    'the cap must be published as a job output'
  );

  // A push to main starts the kilo-app CI run and this release run from the
  // same commit, so the release consumes that run's conclusion instead of
  // executing the suite again. The hourly schedule and a manual run of main
  // stand on the tip of main, so they reuse that push run as well, but only
  // once it has concluded. The lookup is fail-closed: the step publishes
  // reuse=false before any decision, only a push, a schedule or a manual run of
  // main may reuse, and only a run that concluded successfully is a validation
  // for this commit.
  const suite = step(workflow, 'check-changes', 'suite');
  assert.ok(suite, 'check-changes: the suite reuse step (id suite) is missing');
  assert.equal(
    suite.if,
    "steps.check.outputs.should_build == 'true' && steps.cap.outputs.allowed == 'true'",
    'the suite lookup must run only for a build the cap admits'
  );
  assert.equal(checkChanges.outputs.reuse, '${{ steps.suite.outputs.reuse }}');
  assert.equal(checkChanges.outputs.suite_run, '${{ steps.suite.outputs.suite_run }}');
  assert.equal(
    checkChanges.permissions?.actions,
    'read',
    'check-changes must read the run of the workflow it reuses'
  );
  const reuseDefault = suite.run.indexOf('echo "reuse=false" >> "$GITHUB_OUTPUT"');
  assert.ok(reuseDefault >= 0, 'the suite step must default to running the suite');
  assert.ok(
    reuseDefault < suite.run.indexOf('GITHUB_EVENT_NAME'),
    'the fail-closed default must be published before the lookup'
  );
  const gateStart = suite.run.indexOf('case "$GITHUB_EVENT_NAME" in');
  assert.ok(gateStart >= 0, 'the suite step must gate the lookup on the event');
  const eventGate = suite.run.slice(gateStart, suite.run.indexOf('esac', gateStart));
  assert.match(
    eventGate,
    /push\) REUSE_RUNNING=true/,
    'a push reuses the suite run it started, which may still be in flight'
  );
  assert.match(
    eventGate,
    /schedule\) REUSE_RUNNING=false/,
    'the schedule reuses the push run of the commit it resumes at'
  );
  assert.match(
    eventGate,
    /workflow_dispatch\)\s*\n\s*if \[ "\$GITHUB_REF" != "refs\/heads\/main" \][\s\S]*?exit 0/,
    'a manual run of another ref has no push run of its commit to reuse'
  );
  assert.match(
    eventGate,
    /\*\)\s*\n\s*echo "[^"]*"[\s\S]*?exit 0/,
    'an event that is not a release run of main keeps the in-workflow suite'
  );
  assert.match(
    suite.run,
    /\[ "\$STATUS" != "completed" \] && \[ "\$REUSE_RUNNING" = "false" \][\s\S]*?exit 0/,
    'a schedule or a manual run of main reuses only a suite run that concluded'
  );
  // A skipped suite still reports success, and the tip of main need not be a
  // commit that touched an app path, so the shard job is the proof that the run
  // this path reuses executed the suite.
  assert.match(
    suite.run,
    /actions\/runs\/\$ID\/jobs\?per_page=100&filter=latest/,
    'a schedule or a manual run of main must read the jobs of the run it reuses'
  );
  assert.match(
    suite.run,
    /select\(\.name == "mobile-test \(1\/8\)"\)/,
    'the proof must read a shard job that runs only when the suite runs'
  );
  assert.match(
    suite.run,
    /\[ "\$SHARD" != "success" \][\s\S]*?exit 0/,
    'a run that did not execute the suite leaves the suite to this workflow'
  );
  assert.match(
    suite.run,
    /actions\/workflows\/kilo-app-ci\.yml\/runs\?head_sha=\$GITHUB_SHA&event=push/,
    'the lookup must read the kilo-app CI push run of this exact commit'
  );
  assert.match(
    suite.run,
    /\$CONCLUSION" != "success"[\s\S]*?exit 0/,
    'a suite run that did not pass leaves the suite to run in this workflow'
  );
  assert.match(
    suite.run,
    /echo "reuse=true" >> "\$GITHUB_OUTPUT"[\s\S]*echo "suite_run=\$ID" >> "\$GITHUB_OUTPUT"/,
    'the step must publish the run the gate waits for'
  );

  // The gate publishes whether the run settled the validation, and the
  // in-workflow suite covers every case it did not: a manual run of another
  // ref, a lookup that cannot prove a run, and a run that ended without a
  // pass, which includes one a later push cancelled.
  const reuseJob = workflow.jobs.reuse;
  assert.ok(reuseJob, 'the reuse gate job is missing');
  assert.ok(
    (reuseJob.needs ?? []).includes('check-changes'),
    'the reuse gate must depend on check-changes'
  );
  assert.match(
    reuseJob.if,
    /needs\.check-changes\.outputs\.reuse == 'true'/,
    'the reuse gate must run only for a suite run it can wait for'
  );
  assert.equal(
    reuseJob.permissions?.actions,
    'read',
    'the reuse gate must read the suite run status'
  );
  assert.equal(
    reuseJob.outputs?.suite,
    '${{ steps.wait.outputs.suite }}',
    'the gate must publish its decision to the build condition'
  );
  const wait = reuseJob.steps.find(item => item.id === 'wait');
  assert.ok(wait, 'the reuse gate must wait for the suite run');
  assert.equal(
    wait.env?.SUITE_RUN,
    '${{ needs.check-changes.outputs.suite_run }}',
    'the gate must wait for the run check-changes published'
  );
  // Fail closed: only an observed pass may turn the decision over, so the
  // default is published before the first read.
  const fallbackDefault = wait.run.indexOf('echo "suite=fallback" >> "$GITHUB_OUTPUT"');
  assert.ok(fallbackDefault >= 0, 'the gate must default to the in-workflow suite');
  assert.ok(
    fallbackDefault < wait.run.indexOf('gh api'),
    'the fallback default must be published before the gate reads a run'
  );
  // The gate has no checkout, so it names the repository in the path and reads
  // the conclusion instead of the exit code of a watch: a failed or cancelled
  // run leaves the suite to this workflow rather than failing the release.
  assert.match(
    wait.run,
    /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$SUITE_RUN"/,
    'the gate must read the run check-changes published'
  );
  assert.match(wait.run, /\[ "\$CONCLUSION" = "success" \]/, 'only a passed run is reused');
  assert.match(
    wait.run,
    /echo "suite=passed" >> "\$GITHUB_OUTPUT"/,
    'an observed pass must publish the reuse decision'
  );
  assert.equal(
    (wait.run.match(/exit 1\b/g) ?? []).length,
    1,
    'the only failing exit is the missing run id; a run without a pass falls back'
  );

  assert.equal(
    workflow.jobs.validate.uses,
    './.github/workflows/kilo-app-ci.yml',
    'the schedule and manual paths must keep the in-workflow suite'
  );
  assert.deepEqual(
    [...(workflow.jobs.validate.needs ?? [])].sort(),
    ['check-changes', 'reuse'],
    'the in-workflow suite must read the gate decision'
  );
  assert.match(
    workflow.jobs.validate.if,
    /\${{ !cancelled\(\)/,
    'the in-workflow suite needs a status function because the gate is often skipped'
  );
  assert.match(
    workflow.jobs.validate.if,
    /needs\.check-changes\.outputs\.reuse == 'false' \|\| needs\.reuse\.outputs\.suite == 'fallback'/,
    'the in-workflow suite must run when no run is reused or the reused run ended without a pass'
  );

  // The cost gate is the last thing before any build: every job that builds or
  // submits needs it, not only the build itself.
  for (const jobName of ['validate', 'reuse', 'preflight', 'build-and-submit', 'bump-version']) {
    assert.match(
      workflow.jobs[jobName].if ?? '',
      /needs\.check-changes\.outputs\.allowed == 'true'/,
      `${jobName} must require the upload cap`
    );
  }
  assert.ok(
    (workflow.jobs.validate.needs ?? []).includes('check-changes'),
    'validate must depend on check-changes'
  );

  // The store identity is read from the built IPA after the build and before the
  // upload, so a mismatched artifact fails before the stores.
  const buildJob = workflow.jobs['build-and-submit'];
  const names = buildJob.steps.map(item => item.name);
  const buildIndex = names.indexOf('Build iOS and Android');
  const identityIndex = buildJob.steps.findIndex(item => item.id === 'identity');
  const submitIndex = names.indexOf('Submit iOS');
  assert.ok(buildIndex >= 0, 'build-and-submit: the build step is missing');
  assert.ok(
    identityIndex > buildIndex,
    'the store identity must be read after Build iOS and Android'
  );
  assert.ok(
    submitIndex >= 0 && identityIndex < submitIndex,
    'the store identity must be read before Submit iOS'
  );
  assert.match(
    buildJob.steps[identityIndex].run,
    /kilo-app-release-notes\.mjs identity/,
    'the identity step must run the identity subcommand'
  );
  assert.equal(buildJob.outputs.ios_build, '${{ steps.identity.outputs.ios_build }}');
  assert.equal(buildJob.outputs.android_build, '${{ steps.identity.outputs.android_build }}');

  // The build starts only after a gate proved the suite for this commit, once:
  // either the gate observed a passed run and the suite did not run here, or
  // the suite ran here and passed and the gate reused nothing. A skipped need
  // skips this job without a status function, and the status function alone
  // would ignore a failed gate, so the condition carries both.
  assert.deepEqual(
    [...(buildJob.needs ?? [])].sort(),
    ['check-changes', 'preflight', 'reuse', 'validate'],
    'the build must need both suite gates, the change check and the preflight'
  );
  assert.match(
    buildJob.if,
    /\${{ !cancelled\(\)/,
    'the build condition needs a status function because a gate is always skipped'
  );
  assert.match(
    buildJob.if,
    /needs\.preflight\.result == 'success'/,
    'a failed preflight must block the build'
  );
  assert.match(
    buildJob.if,
    /needs\.reuse\.result == 'success' && needs\.reuse\.outputs\.suite == 'passed' && needs\.validate\.result == 'skipped'/,
    'the reused run must be a passed one when the gate is what proved the suite'
  );
  assert.match(
    buildJob.if,
    /needs\.validate\.result == 'success' && needs\.reuse\.outputs\.suite != 'passed'/,
    'a passed in-workflow suite must stand in when no run was reused'
  );

  // The cap counts iOS submissions, and a run that uploads the IPA and then
  // fails at Submit Android is a real App Store Connect upload that writes no
  // release tag. The marker is pushed before Submit iOS, so an accepted upload
  // can never be missing from the ledger, and it is annotated so its
  // creatordate is the submission moment.
  const submitIosIndex = names.indexOf('Submit iOS');
  const submitAndroidIndex = names.indexOf('Submit Android');
  const markerIndex = buildJob.steps.findIndex(item => /kilo-app-upload\//.test(item.run ?? ''));
  assert.ok(submitIosIndex >= 0, 'build-and-submit: the Submit iOS step is missing');
  assert.ok(submitAndroidIndex >= 0, 'build-and-submit: the Submit Android step is missing');
  assert.ok(markerIndex >= 0, 'build-and-submit: the iOS upload marker step is missing');
  assert.ok(
    markerIndex < submitIosIndex && markerIndex < submitAndroidIndex,
    'the iOS upload marker must be pushed before Submit iOS, so an upload the stores accepted is never missing from the cap ledger'
  );
  const marker = buildJob.steps[markerIndex];
  assert.match(
    marker.run,
    /git config user\.email "41898282\+github-actions\[bot\]@users\.noreply\.github\.com"[\s\S]*git tag -a "\$MARKER"/,
    'the annotated marker needs a tagger identity before it is created'
  );
  assert.match(
    marker.run,
    /git tag -a "\$MARKER" -m "\$MARKER"/,
    'the marker must be annotated, so its creatordate is the submission moment'
  );
  assert.match(marker.run, /git push origin "\$MARKER"/, 'the marker must be pushed');
  assert.match(
    marker.run,
    /GITHUB_RUN_ID.*GITHUB_RUN_ATTEMPT/,
    'the marker name must be unique per run, so a retried upload does not collide'
  );

  // The version-bump job publishes the branch the changelog section lands on.
  // It pushes the branch but never opens the PR: a PR opened during the build
  // window can be merged (and the branch auto-deleted) before the section
  // lands, which loses the build's changelog line for ever.
  const bumpJob = workflow.jobs['bump-version'];
  assert.equal(
    bumpJob.outputs.branch,
    '${{ steps.pending.outputs.branch || steps.bump.outputs.branch }}',
    'bump-version must publish the branch it opens or reuses'
  );
  for (const item of bumpJob.steps) {
    assert.ok(
      !/\bgh pr create\b/.test(item.run ?? ''),
      'bump-version must not open the PR; the changelog job opens it after the section lands'
    );
  }
  assert.match(
    step(workflow, 'bump-version', 'bump').run,
    /branch=kilo-app-version-bump-\$NEW/,
    'the bump step must record the branch it created'
  );

  const changelog = workflow.jobs.changelog;
  assert.ok(changelog, 'the changelog job is missing');
  for (const need of ['check-changes', 'bump-version', 'build-and-submit']) {
    assert.ok((changelog.needs ?? []).includes(need), `changelog must need ${need}`);
  }
  // Opening or refreshing the PR needs pull-requests: write; the assignee is an
  // Issues API operation.
  assert.equal(changelog.permissions?.['pull-requests'], 'write');
  assert.equal(changelog.permissions?.issues, 'write');

  const writeIndex = changelog.steps.findIndex(item =>
    /kilo-app-release-notes\.mjs write/.test(item.run ?? '')
  );
  const write = changelog.steps[writeIndex];
  assert.ok(write, 'changelog must run the write subcommand');
  // The branch reaches the shell as an environment value, never as an
  // interpolated ${{ }}, and only the exact name this pipeline creates passes:
  // a crafted ref name must not become command substitution.
  assert.equal(
    write.env?.BRANCH,
    '${{ needs.bump-version.outputs.branch }}',
    'the changelog must receive the branch as an environment value'
  );
  assert.ok(
    !/\$\{\{\s*needs\.bump-version\.outputs\.branch\s*\}\}/.test(write.run),
    'the branch must never be interpolated into the changelog shell'
  );
  assert.match(
    write.run,
    /grep -qE '\^kilo-app-version-bump-\[0-9\.\]\+\$'/,
    'the changelog step must reject an unexpected branch before use'
  );
  assert.match(
    write.run,
    /--land "origin:\$BRANCH"/,
    'the section must land on the version-bump branch'
  );
  assert.match(write.run, /--version "\$\{\{ needs\.check-changes\.outputs\.version \}\}"/);
  assert.match(write.run, /--ios-build "\$\{\{ needs\.build-and-submit\.outputs\.ios_build \}\}"/);
  assert.match(
    write.run,
    /--android-build "\$\{\{ needs\.build-and-submit\.outputs\.android_build \}\}"/
  );
  // A branch that was merged during the build must not lose the section: it is
  // carried to the pending branch, and the land step publishes whether it
  // landed so the PR step is skipped.
  assert.match(write.run, /--pending "\$PENDING"/, 'the section must carry a failed land');
  assert.match(
    write.env?.PENDING ?? '',
    /^kilo-app-changelog-pending$/,
    'the pending branch is fixed'
  );
  assert.equal(write.id, 'land', 'the land step must publish an output the PR step can read');
  assert.match(
    write.run,
    /grep -q '\^changelog: landed '[\s\S]*echo "landed=true" >> "\$GITHUB_OUTPUT"/,
    'the land step must report a landed section'
  );

  // The PR is opened or refreshed only after the section landed, so the version
  // line and the section are on the branch together before a human merges.
  const prIndex = changelog.steps.findIndex(item => /\bgh pr create\b/.test(item.run ?? ''));
  const pr = changelog.steps[prIndex];
  assert.ok(pr, 'the changelog job must open the version-bump PR');
  assert.ok(prIndex > writeIndex, 'the changelog must land the section before it opens the PR');
  assert.equal(
    pr.if,
    "steps.land.outputs.landed == 'true'",
    'the PR must not be opened when the section did not land'
  );
  assert.match(pr.run, /\bgh pr edit\b/, 'an already open PR must be refreshed, not duplicated');
  // This job checks out main, and `gh pr create` reads the head from the
  // checked-out branch when --head is absent: the API then refuses the PR with
  // "No commits between main and main" and the version bump is never offered.
  assert.match(
    pr.run,
    /gh pr create[\s\S]*?--head "\$BRANCH"/,
    'the version-bump PR must name the branch it carries, not the checked-out main'
  );
  assert.equal(
    pr.env?.BRANCH,
    '${{ needs.bump-version.outputs.branch }}',
    'the PR step must receive the branch as an environment value'
  );
  assert.ok(
    !/\$\{\{\s*needs\.bump-version\.outputs\.branch\s*\}\}/.test(pr.run),
    'the branch must never be interpolated into the PR shell'
  );
}

test('the release workflow gates the build on the upload cap and lands the changelog section', () => {
  validate(readWorkflow());
});

test('release retries preserve shipped sections on a bump branch without a PR', () => {
  const work = mkdtempSync(join(tmpdir(), 'kilo-app-bump-'));
  const repo = join(work, 'repo');
  const remote = join(work, 'remote.git');
  const output = join(work, 'output');
  const workflow = readWorkflow();
  const env = { ...process.env, GITHUB_OUTPUT: output };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  const run = (body, cwd = repo) => {
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', body], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => line.split('='))
    );
  };
  const runBump = previousPending => {
    const outputs = previousPending ? { pending: previousPending } : {};
    for (const item of workflow.jobs['bump-version'].steps.filter(item => item.run)) {
      if (item.id === 'pending' && previousPending) {
        continue;
      }
      if (item.if) {
        const condition = /^steps\.([^.]+)\.outputs\.([a-z_]+) == '([^']*)'$/.exec(item.if);
        assert.ok(condition, `Unsupported fixture condition: ${item.if}`);
        if (outputs[condition[1]]?.[condition[2]] !== condition[3]) {
          continue;
        }
      }
      const body = item.run.replaceAll(
        /\$\{\{\s*steps\.([^.]+)\.outputs\.([a-z_]+)\s*\}\}/g,
        (_, id, key) => outputs[id][key]
      );
      const result = run(
        body,
        item['working-directory'] ? join(repo, item['working-directory']) : repo
      );
      if (item.id) {
        outputs[item.id] = result;
      }
    }
    return outputs;
  };
  try {
    mkdirSync(join(repo, 'apps/mobile'), { recursive: true });
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Release Test');
    git('config', 'user.email', 'release@example.invalid');
    git('remote', 'add', 'origin', remote);
    writeFileSync(
      join(repo, 'apps/mobile/app.config.ts'),
      "export default {\n  version: '1.2.3',\n};\n"
    );
    writeFileSync(join(repo, 'apps/mobile/CHANGELOG.md'), '# Changelog\n');
    git('add', '.');
    git('commit', '-m', 'Initial app');
    const base = git('rev-parse', 'HEAD');

    const first = runBump();
    assert.equal(first.pending.open, '0');
    const branch = first.bump.branch;
    assert.equal(
      git('show', `${branch}:apps/mobile/app.config.ts`),
      "export default {\n  version: '1.2.4',\n};"
    );

    const shipped = '# Changelog\n\n## shipped build\n\n- A shipped change.\n';
    writeFileSync(join(repo, 'apps/mobile/CHANGELOG.md'), shipped);
    git('add', '.');
    git('commit', '-m', 'Document shipped build');
    git('push', 'origin', branch);
    const documented = git('rev-parse', 'HEAD');
    git('checkout', '--detach', base);
    git('branch', '-D', branch);
    const retry = runBump();
    assert.equal(retry.pending.open, '1');
    assert.equal(retry.pending.branch, branch);
    assert.equal(
      git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split(/\s/)[0],
      documented
    );
    assert.equal(git('show', `${documented}:apps/mobile/CHANGELOG.md`), shipped.trim());

    assert.throws(
      () => runBump(first.pending),
      error => error.status === 1 && /non-fast-forward|fetch first/.test(error.stderr.toString())
    );
    assert.equal(
      git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split(/\s/)[0],
      documented
    );

    git('remote', 'set-url', 'origin', join(work, 'missing.git'));
    assert.throws(
      () => runBump(),
      error =>
        error.status === 128 &&
        /missing\.git.*does not appear to be a git repository/.test(error.stderr.toString())
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the suite lookup reuses a passed run and otherwise runs the suite here', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kilo-app-suite-'));
  const stubDir = join(workspace, 'bin');
  const runsPath = join(workspace, 'runs.json');
  const callsPath = join(workspace, 'calls');
  const output = join(workspace, 'output');
  mkdirSync(stubDir, { recursive: true });
  // `gh` answers with the newest run of the workflow and event the lookup asks
  // for, in gojq's shape: an empty match prints the two empty fields it would
  // emit for a null run. A jobs read answers with the shard conclusion the case
  // gives it, which is the proof that the suite ran. A failure case answers
  // like an API error. `sleep` is stubbed out so the bounded wait for the runs
  // list does not slow the test.
  writeFileSync(
    join(stubDir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const calls = process.env.GH_STUB_CALLS;
const prior = fs.existsSync(calls)
  ? fs.readFileSync(calls, 'utf8').trim().split('\\n').filter(Boolean)
  : [];
const args = process.argv.slice(2);
fs.appendFileSync(calls, args.join(' ') + '\\n');
if (args.some(arg => arg.includes('/jobs?'))) {
  if (process.env.GH_STUB_JOBS_ERROR === '1') {
    process.stderr.write('HTTP 500: internal server error\\n');
    process.exit(1);
  }
  process.stdout.write((process.env.GH_STUB_SHARD ?? 'success') + '\\n');
  process.exit(0);
}
if (process.env.GH_STUB_ERROR === '1') {
  process.stderr.write('HTTP 503: service unavailable\\n');
  process.exit(1);
}
const seen = prior.filter(line => !line.includes('/jobs?')).length;
const script = JSON.parse(fs.readFileSync(process.env.GH_STUB_RUNS, 'utf8'));
const run = (script[Math.min(seen, script.length - 1)] ?? [])[0];
process.stdout.write(run ? [run.id, run.status, run.conclusion ?? ''].join('\\t') + '\\n' : '\\t\\t\\n');
`,
    { mode: 0o755 }
  );
  writeFileSync(join(stubDir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const suite = step(readWorkflow(), 'check-changes', 'suite');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  // `runs` is one entry per lookup: the last entry answers every later call.
  // `shard` is the conclusion of the shard job in the jobs read.
  const lookup = ({
    event,
    ref = 'refs/heads/main',
    runs,
    error,
    shard = 'success',
    jobsError = false,
  }) => {
    writeFileSync(runsPath, JSON.stringify(runs));
    writeFileSync(callsPath, '');
    writeFileSync(output, '');
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', suite.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: 'Kilo-Org/cloud',
        GITHUB_SHA: sha,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        GH_STUB_RUNS: runsPath,
        GH_STUB_CALLS: callsPath,
        GH_STUB_ERROR: error ? '1' : '0',
        GH_STUB_SHARD: shard,
        GH_STUB_JOBS_ERROR: jobsError ? '1' : '0',
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean);
    return { outputs, calls };
  };

  try {
    const passed = lookup({
      event: 'push',
      runs: [[{ id: 42, status: 'completed', conclusion: 'success' }]],
    });
    assert.deepEqual(passed.outputs, { reuse: 'true', suite_run: '42' });
    assert.match(
      passed.calls[0],
      new RegExp(
        `^api repos/Kilo-Org/cloud/actions/workflows/kilo-app-ci\\.yml/runs\\?head_sha=${sha}&event=push`
      )
    );

    // Still running: the gate is what waits for it, so the run is reused.
    const running = lookup({
      event: 'push',
      runs: [[{ id: 44, status: 'in_progress', conclusion: null }]],
    });
    assert.deepEqual(running.outputs, { reuse: 'true', suite_run: '44' });

    // The runs list can lag the run the same push started: the step waits for
    // it and reuses it once it appears.
    const lagging = lookup({
      event: 'push',
      runs: [[], [{ id: 45, status: 'completed', conclusion: 'success' }]],
    });
    assert.deepEqual(lagging.outputs, { reuse: 'true', suite_run: '45' });
    assert.equal(lagging.calls.length, 2, 'the lookup must wait for the runs list to catch up');

    // Fail closed: a suite that did not pass, a lookup error, and an empty
    // lookup each leave the suite to run in this workflow.
    const failed = lookup({
      event: 'push',
      runs: [[{ id: 43, status: 'completed', conclusion: 'failure' }]],
    });
    assert.deepEqual(failed.outputs, { reuse: 'false' });
    assert.equal(failed.calls.length, 1);

    const errored = lookup({ event: 'push', runs: [[]], error: true });
    assert.deepEqual(errored.outputs, { reuse: 'false' });
    assert.equal(errored.calls.length, 1, 'a failed lookup must not keep retrying');

    const empty = lookup({ event: 'push', runs: [[]] });
    assert.deepEqual(empty.outputs, { reuse: 'false' });

    // A schedule stands on the tip of main, which the push that put it there
    // validated: it reuses that concluded pass instead of running the suite.
    const scheduled = lookup({
      event: 'schedule',
      runs: [[{ id: 46, status: 'completed', conclusion: 'success' }]],
    });
    assert.deepEqual(scheduled.outputs, { reuse: 'true', suite_run: '46' });
    assert.match(
      scheduled.calls[0],
      new RegExp(
        `^api repos/Kilo-Org/cloud/actions/workflows/kilo-app-ci\\.yml/runs\\?head_sha=${sha}&event=push`
      ),
      'the schedule must read the push run of its own commit'
    );
    assert.match(
      scheduled.calls[1],
      /^api repos\/Kilo-Org\/cloud\/actions\/runs\/46\/jobs\?/,
      'the schedule must prove the suite ran in the run it reuses'
    );
    assert.equal(scheduled.calls.length, 2, 'one run read and one jobs read');

    // It never waits on a suite it did not start, and it reuses nothing that
    // is not already a pass.
    const scheduledRunning = lookup({
      event: 'schedule',
      runs: [[{ id: 47, status: 'in_progress', conclusion: null }]],
    });
    assert.deepEqual(scheduledRunning.outputs, { reuse: 'false' });
    assert.equal(scheduledRunning.calls.length, 1);

    const scheduledFailed = lookup({
      event: 'schedule',
      runs: [[{ id: 48, status: 'completed', conclusion: 'cancelled' }]],
    });
    assert.deepEqual(scheduledFailed.outputs, { reuse: 'false' });

    // A run whose suite jobs were skipped for a commit that touched no app path
    // still reports success, and that is no validation for the app change this
    // release submits.
    const skipped = lookup({
      event: 'schedule',
      runs: [[{ id: 53, status: 'completed', conclusion: 'success' }]],
      shard: 'skipped',
    });
    assert.deepEqual(skipped.outputs, { reuse: 'false' });
    assert.equal(skipped.calls.length, 2, 'the suite proof must read the jobs');

    // A jobs read that fails proves nothing either.
    const jobsErrored = lookup({
      event: 'schedule',
      runs: [[{ id: 54, status: 'completed', conclusion: 'success' }]],
      jobsError: true,
    });
    assert.deepEqual(jobsErrored.outputs, { reuse: 'false' });

    // A manual run of main follows the same rule.
    const dispatched = lookup({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      runs: [[{ id: 49, status: 'completed', conclusion: 'success' }]],
    });
    assert.deepEqual(dispatched.outputs, { reuse: 'true', suite_run: '49' });

    const dispatchedSkipped = lookup({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      runs: [[{ id: 55, status: 'completed', conclusion: 'success' }]],
      shard: 'skipped',
    });
    assert.deepEqual(dispatchedSkipped.outputs, { reuse: 'false' });

    const dispatchedRunning = lookup({
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      runs: [[{ id: 50, status: 'queued', conclusion: null }]],
    });
    assert.deepEqual(dispatchedRunning.outputs, { reuse: 'false' });

    // A manual run of another ref has no push run of its commit, and an event
    // that is not a release run of main has nothing to reuse.
    const dispatchedBranch = lookup({
      event: 'workflow_dispatch',
      ref: 'refs/heads/kilo-app-version-bump-1.2.3',
      runs: [[{ id: 51, status: 'completed', conclusion: 'success' }]],
    });
    assert.deepEqual(dispatchedBranch.outputs, { reuse: 'false' });
    assert.equal(dispatchedBranch.calls.length, 0, 'a branch dispatch must not look up a run');

    const other = lookup({
      event: 'pull_request',
      ref: 'refs/pull/1/merge',
      runs: [[{ id: 52, status: 'completed', conclusion: 'success' }]],
    });
    assert.deepEqual(other.outputs, { reuse: 'false' });
    assert.equal(other.calls.length, 0, 'only a release run of main may reuse a run');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the reuse gate waits for the run and falls back when it never passed', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kilo-app-gate-'));
  const stubDir = join(workspace, 'bin');
  const runsPath = join(workspace, 'run');
  const callsPath = join(workspace, 'calls');
  const output = join(workspace, 'output');
  mkdirSync(stubDir, { recursive: true });
  // `gh` answers the single-run read in the shape the step asks for: status and
  // conclusion as two tab-separated fields, one line per read, and the last
  // line again for every later read. `sleep` is stubbed out so the gate's
  // interval does not slow the test.
  writeFileSync(
    join(stubDir, 'gh'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_CALLS"
if [ "$GH_STUB_ERROR" = "1" ]; then
  echo "HTTP 503: service unavailable" >&2
  exit 1
fi
COUNT=$(wc -l < "$GH_STUB_CALLS")
TOTAL=$(wc -l < "$GH_STUB_RUN")
INDEX=$((COUNT - 1))
if [ "$INDEX" -ge "$TOTAL" ]; then INDEX=$((TOTAL - 1)); fi
sed -n "$((INDEX + 1))p" "$GH_STUB_RUN"
`,
    { mode: 0o755 }
  );
  writeFileSync(join(stubDir, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const wait = step(readWorkflow(), 'reuse', 'wait');
  const gate = ({ runs = [], error = false, suiteRun = '77' } = {}) => {
    writeFileSync(
      runsPath,
      runs.map(run => `${[run.status, run.conclusion ?? ''].join('\t')}\n`).join('')
    );
    writeFileSync(callsPath, '');
    writeFileSync(output, '');
    let status = 0;
    try {
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', wait.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${stubDir}:${process.env.PATH}`,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'Kilo-Org/cloud',
          SUITE_RUN: suiteRun,
          GH_STUB_RUN: runsPath,
          GH_STUB_CALLS: callsPath,
          GH_STUB_ERROR: error ? '1' : '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (failure) {
      status = failure.status;
    }
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean);
    return { status, outputs, calls };
  };

  try {
    // A run that is still going is waited for, and its pass is the decision.
    const passed = gate({
      runs: [
        { status: 'queued' },
        { status: 'in_progress' },
        { status: 'completed', conclusion: 'success' },
      ],
    });
    assert.equal(passed.status, 0);
    assert.deepEqual(passed.outputs, { suite: 'passed' });
    assert.equal(passed.calls.length, 3, 'the gate must wait for the run to finish');
    assert.match(
      passed.calls[0],
      /^api repos\/Kilo-Org\/cloud\/actions\/runs\/77 /,
      'the gate must read the run check-changes published'
    );

    const settled = gate({ runs: [{ status: 'completed', conclusion: 'success' }] });
    assert.deepEqual(settled.outputs, { suite: 'passed' });
    assert.equal(settled.calls.length, 1, 'a settled pass needs one read');

    // A cancelled run carries no verdict about this commit: the suite runs in
    // this workflow and the release does not fail at the gate. A merge burst
    // produces exactly this, because the app workflow cancels its own main run.
    const cancelled = gate({ runs: [{ status: 'completed', conclusion: 'cancelled' }] });
    assert.equal(cancelled.status, 0, 'a cancelled reuse must not fail the release');
    assert.deepEqual(cancelled.outputs, { suite: 'fallback' });

    // A failure is no validation of this commit either.
    const failed = gate({ runs: [{ status: 'completed', conclusion: 'failure' }] });
    assert.equal(failed.status, 0);
    assert.deepEqual(failed.outputs, { suite: 'fallback' });

    // An unreadable run and a run that never settles both fall back, and the
    // wait is bounded.
    const errored = gate({ error: true });
    assert.equal(errored.status, 0, 'a failed read must not fail the release');
    assert.deepEqual(errored.outputs, { suite: 'fallback' });
    assert.equal(errored.calls.length, 1, 'a failed read must not keep retrying');

    const stalled = gate({ runs: [{ status: 'in_progress' }] });
    assert.equal(stalled.status, 0);
    assert.deepEqual(stalled.outputs, { suite: 'fallback' });
    assert.equal(stalled.calls.length, 110, 'the wait must stay bounded');

    // Only the run id check-changes never published fails the gate.
    const missing = gate({ suiteRun: '' });
    assert.equal(missing.status, 1);
    assert.deepEqual(missing.calls, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('every path that triggers a release is inside kilo-app CI change detection', () => {
  const ci = load(readFileSync(new URL(`../${ciWorkflowPath}`, import.meta.url), 'utf8'));
  const detect = ci.jobs['mobile-changes'].steps.find(item => item.id === 'detect');
  assert.ok(detect, 'kilo-app CI must detect the mobile changes');
  const patterns = readWorkflow().on.push.paths;
  assert.ok(patterns?.length > 0, 'the release must trigger on the app paths');
  for (const pattern of patterns) {
    const prefix = pattern.replace(/\/\*\*$/, '');
    assert.match(
      detect.run,
      new RegExp(`\\^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
      `kilo-app CI must run the suite for ${pattern}: the release reuses that run instead of executing the suite`
    );
  }
});

test('the mobile build tooling runs the EAS CLI the workspace installs', () => {
  validateEasCli(
    readWorkflow(),
    readJson(mobilePackagePath),
    readJson(easConfigPath),
    readLockfile()
  );
});
const mutations = {
  'change detection keeps CHANGELOG.md': workflow => {
    const check = step(workflow, 'check-changes', 'check');
    check.run = check.run.replace(" ':(exclude)apps/mobile/CHANGELOG.md'", '');
  },
  'LAST_TAG is computed after the manual override': workflow => {
    const check = step(workflow, 'check-changes', 'check');
    const lines = check.run.split('\n');
    const index = lines.findIndex(line => line.includes('LAST_TAG=$(git tag'));
    lines.push(...lines.splice(index, 1));
    check.run = lines.join('\n');
  },
  'the submitted version is not printed': workflow => {
    const check = step(workflow, 'check-changes', 'check');
    check.run = check.run.replace('version=$VERSION', 'value=$VERSION');
  },
  'the allowed output is dropped': workflow => {
    delete workflow.jobs['check-changes'].outputs.allowed;
  },
  'the version output is dropped': workflow => {
    delete workflow.jobs['check-changes'].outputs.version;
  },
  'the notes output is dropped': workflow => {
    delete workflow.jobs['check-changes'].outputs.notes;
  },
  'the notes step loses the body subcommand': workflow => {
    const notes = step(workflow, 'check-changes', 'notes');
    notes.run = notes.run.replaceAll(
      'kilo-app-release-notes.mjs body',
      'kilo-app-release-notes.mjs render'
    );
  },
  'the notes step loses the heredoc': workflow => {
    const notes = step(workflow, 'check-changes', 'notes');
    notes.run = notes.run.replace('notes<<NOTES_EOF', 'notes=');
  },
  'the cap is raised': workflow => {
    const cap = step(workflow, 'check-changes', 'cap');
    cap.run = cap.run.replace('--cap 10', '--cap 100');
  },
  'the cap step ignores the allowed line': workflow => {
    const cap = step(workflow, 'check-changes', 'cap');
    cap.run = cap.run.replace('^allowed=', '^xallowed=');
  },
  'the cap output is not published': workflow => {
    const cap = step(workflow, 'check-changes', 'cap');
    cap.run = cap.run.replace(' >> "$GITHUB_OUTPUT"', '');
  },
  'the cap counts release tags instead of upload markers': workflow => {
    const cap = step(workflow, 'check-changes', 'cap');
    cap.run = cap.run.replace('--prefix kilo-app-upload/', '--prefix kilo-app-release/');
  },
  'the suite lookup defaults to reuse': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace('echo "reuse=false" >> "$GITHUB_OUTPUT"\n', '');
  },
  'the suite lookup runs before the cap decision': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.if = "steps.check.outputs.should_build == 'true'";
  },
  'the suite lookup reads another commit': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace('head_sha=$GITHUB_SHA&', 'head_sha=&');
  },
  'the suite lookup runs for a manual run of another ref': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace(
      'if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
      'if false; then'
    );
  },
  'the suite lookup runs for any event': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace(/(\*\)\n\s+echo "[^"]*"\n\s+)exit 0/, '$1:');
  },
  'the schedule reuses a suite run still in flight': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace('schedule) REUSE_RUNNING=false', 'schedule) REUSE_RUNNING=true');
  },
  'the suite proof reads a job that runs for every commit': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace(
      'select(.name == "mobile-test (1/8)")',
      'select(.name == "mobile-changes")'
    );
  },
  'the suite proof accepts a skipped shard': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace('[ "$SHARD" != "success" ]', '[ "$SHARD" = "stale" ]');
  },
  'the suite lookup reuses a run that did not pass': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace(
      '[ "$CONCLUSION" != "success" ]',
      '[ "$CONCLUSION" = "success" ]'
    );
  },
  'the suite step publishes no run id': workflow => {
    const suite = step(workflow, 'check-changes', 'suite');
    suite.run = suite.run.replace('echo "suite_run=$ID" >> "$GITHUB_OUTPUT"', '');
  },
  'the reuse output is dropped': workflow => {
    delete workflow.jobs['check-changes'].outputs.reuse;
  },
  'check-changes cannot read runs': workflow => {
    delete workflow.jobs['check-changes'].permissions.actions;
  },
  'validate ignores a reuse without a pass': workflow => {
    workflow.jobs.validate.if = workflow.jobs.validate.if.replace(
      " || needs.reuse.outputs.suite == 'fallback'",
      ''
    );
  },
  'the reuse gate accepts any run': workflow => {
    workflow.jobs.reuse.if = workflow.jobs.reuse.if.replace(
      " && needs.check-changes.outputs.reuse == 'true'",
      ''
    );
  },
  'the reuse gate reuses a run that did not pass': workflow => {
    const wait = workflow.jobs.reuse.steps.find(item => item.id === 'wait');
    wait.run = wait.run.replace('[ "$CONCLUSION" = "success" ]', '[ "$CONCLUSION" != "success" ]');
  },
  'the reuse gate defaults to a passed suite': workflow => {
    const wait = workflow.jobs.reuse.steps.find(item => item.id === 'wait');
    wait.run = wait.run.replace('echo "suite=fallback"', 'echo "suite=passed"');
  },
  'the reuse gate fails a release whose run never passed': workflow => {
    const wait = workflow.jobs.reuse.steps.find(item => item.id === 'wait');
    wait.run = wait.run.replace('echo "The suite runs in this workflow instead."', 'exit 1');
  },
  'the reuse gate reads another run': workflow => {
    const wait = workflow.jobs.reuse.steps.find(item => item.id === 'wait');
    wait.run = wait.run.replace('/actions/runs/$SUITE_RUN"', '/actions/runs/1"');
  },
  'the reuse gate waits for an unpublished run': workflow => {
    const wait = workflow.jobs.reuse.steps.find(item => item.id === 'wait');
    delete wait.env.SUITE_RUN;
  },
  'the reuse gate publishes no decision': workflow => {
    delete workflow.jobs.reuse.outputs.suite;
  },
  'the build runs without a status function': workflow => {
    const job = workflow.jobs['build-and-submit'];
    job.if = job.if.replace('!cancelled() && ', '');
  },
  'the build ignores a failed preflight': workflow => {
    const job = workflow.jobs['build-and-submit'];
    job.if = job.if.replace("needs.preflight.result == 'success' && ", '');
  },
  'the build starts when the reused run never passed': workflow => {
    const job = workflow.jobs['build-and-submit'];
    job.if = job.if.replace(
      "needs.reuse.result == 'success' && needs.reuse.outputs.suite == 'passed' && needs.validate.result == 'skipped'",
      "needs.validate.result == 'skipped'"
    );
  },
  'the build starts without a passed in-workflow suite': workflow => {
    const job = workflow.jobs['build-and-submit'];
    job.if = job.if.replace(
      "needs.validate.result == 'success' && needs.reuse.outputs.suite != 'passed'",
      "needs.reuse.outputs.suite != 'passed'"
    );
  },
  'the build drops the reuse gate': workflow => {
    const job = workflow.jobs['build-and-submit'];
    job.needs = job.needs.filter(need => need !== 'reuse');
  },
  'validate drops its dependency': workflow => {
    delete workflow.jobs.validate.needs;
  },
  'the identity step runs after the store upload': workflow => {
    const steps = workflow.jobs['build-and-submit'].steps;
    const index = steps.findIndex(item => item.id === 'identity');
    steps.push(...steps.splice(index, 1));
  },
  'the identity step loses the identity subcommand': workflow => {
    const identity = step(workflow, 'build-and-submit', 'identity');
    identity.run = identity.run.replace(
      'kilo-app-release-notes.mjs identity',
      'kilo-app-release-notes.mjs read'
    );
  },
  'the identity step loses its ios_build output': workflow => {
    delete workflow.jobs['build-and-submit'].outputs.ios_build;
  },
  'the identity step loses its android_build output': workflow => {
    delete workflow.jobs['build-and-submit'].outputs.android_build;
  },
  'the iOS upload marker is dropped': workflow => {
    const steps = workflow.jobs['build-and-submit'].steps;
    steps.splice(
      steps.findIndex(item => /kilo-app-upload\//.test(item.run ?? '')),
      1
    );
  },
  'the iOS upload marker is pushed after Submit Android': workflow => {
    const steps = workflow.jobs['build-and-submit'].steps;
    const index = steps.findIndex(item => /kilo-app-upload\//.test(item.run ?? ''));
    const [marker] = steps.splice(index, 1);
    const android = steps.findIndex(item => item.name === 'Submit Android');
    steps.splice(android + 1, 0, marker);
  },
  'the iOS upload marker is pushed after Submit iOS': workflow => {
    const steps = workflow.jobs['build-and-submit'].steps;
    const index = steps.findIndex(item => /kilo-app-upload\//.test(item.run ?? ''));
    const [marker] = steps.splice(index, 1);
    const ios = steps.findIndex(item => item.name === 'Submit iOS');
    steps.splice(ios + 1, 0, marker);
  },
  'the iOS upload marker is not annotated': workflow => {
    const marker = workflow.jobs['build-and-submit'].steps.find(item =>
      /kilo-app-upload\//.test(item.run ?? '')
    );
    marker.run = marker.run.replace('git tag -a "$MARKER" -m "$MARKER"', 'git tag "$MARKER"');
  },
  'the iOS upload marker has no tagger identity': workflow => {
    const marker = workflow.jobs['build-and-submit'].steps.find(item =>
      /kilo-app-upload\//.test(item.run ?? '')
    );
    marker.run = marker.run.replace(/^\s*git config user\.(name|email).*\n/gm, '');
  },
  'the iOS upload marker is not unique per run': workflow => {
    const marker = workflow.jobs['build-and-submit'].steps.find(item =>
      /kilo-app-upload\//.test(item.run ?? '')
    );
    marker.run = marker.run.replace(
      '${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}',
      '${GITHUB_RUN_ATTEMPT}'
    );
  },
  'bump-version drops its branch output': workflow => {
    delete workflow.jobs['bump-version'].outputs.branch;
  },
  'the created branch is not recorded': workflow => {
    const bump = step(workflow, 'bump-version', 'bump');
    bump.run = bump.run.replace('branch=kilo-app-version-bump-$NEW', '');
  },
  'changelog drops build-and-submit': workflow => {
    workflow.jobs.changelog.needs = workflow.jobs.changelog.needs.filter(
      need => need !== 'build-and-submit'
    );
  },
  'bump-version opens the PR itself': workflow => {
    workflow.jobs['bump-version'].steps.push({
      name: 'Open bump PR',
      run: 'gh pr create --base main --title x --body y',
    });
  },
  'the changelog opens the PR before the section lands': workflow => {
    const steps = workflow.jobs.changelog.steps;
    const index = steps.findIndex(item => /\bgh pr create\b/.test(item.run ?? ''));
    steps.unshift(...steps.splice(index, 1));
  },
  'the changelog opens the PR even when the section did not land': workflow => {
    const pr = workflow.jobs.changelog.steps.find(item => /\bgh pr create\b/.test(item.run ?? ''));
    delete pr.if;
  },
  'the changelog never refreshes an open PR': workflow => {
    const pr = workflow.jobs.changelog.steps.find(item => /\bgh pr create\b/.test(item.run ?? ''));
    pr.run = pr.run.replace(/\bgh pr edit\b/, 'true');
  },
  'the changelog opens the PR on the checked-out branch': workflow => {
    const pr = workflow.jobs.changelog.steps.find(item => /\bgh pr create\b/.test(item.run ?? ''));
    pr.run = pr.run.replace(/(gh pr create[\s\S]*?)--head "\$BRANCH" \\\n/, '$1');
  },
  'the changelog drops the pending carry': workflow => {
    const write = workflow.jobs.changelog.steps.find(item =>
      /kilo-app-release-notes\.mjs write/.test(item.run ?? '')
    );
    write.run = write.run.replace('--pending "$PENDING"', '');
  },
  'the changelog does not report whether the section landed': workflow => {
    const write = workflow.jobs.changelog.steps.find(item =>
      /kilo-app-release-notes\.mjs write/.test(item.run ?? '')
    );
    write.run = write.run.replace(
      'echo "landed=true" >> "$GITHUB_OUTPUT"',
      'echo "landed=yes" >> "$GITHUB_OUTPUT"'
    );
  },
  'the changelog does not receive the branch as an environment value': workflow => {
    delete workflow.jobs.changelog.steps.find(item => item.env?.BRANCH).env.BRANCH;
  },
  'the changelog branch is interpolated into the shell': workflow => {
    const write = workflow.jobs.changelog.steps.find(item =>
      /kilo-app-release-notes\.mjs write/.test(item.run ?? '')
    );
    write.run = write.run.replace(
      '--land "origin:$BRANCH"',
      '--land "origin:${{ needs.bump-version.outputs.branch }}"'
    );
  },
  'the changelog accepts any branch': workflow => {
    const write = workflow.jobs.changelog.steps.find(item =>
      /kilo-app-release-notes\.mjs write/.test(item.run ?? '')
    );
    write.run = write.run.replace(
      "grep -qE '^kilo-app-version-bump-[0-9.]+$'",
      "grep -qE '^kilo-app-version-bump-'"
    );
  },
  'the changelog section lands on main': workflow => {
    const write = workflow.jobs.changelog.steps.find(item =>
      /kilo-app-release-notes\.mjs write/.test(item.run ?? '')
    );
    write.run = write.run.replace('--land "origin:$BRANCH"', '--land "origin:main"');
  },
  'the schedule is removed': workflow => {
    delete workflow.on.schedule;
  },
  'push widens beyond main': workflow => {
    workflow.on.push.branches = ['main', 'release'];
  },
};

for (const jobName of ['validate', 'preflight', 'build-and-submit', 'bump-version']) {
  mutations[`${jobName} ignores the upload cap`] = workflow => {
    const job = workflow.jobs[jobName];
    job.if = job.if.replace(" && needs.check-changes.outputs.allowed == 'true'", '');
  };
}

for (const [name, mutate] of Object.entries(mutations)) {
  test(`the release workflow validator rejects: ${name}`, () => {
    const workflow = readWorkflow();
    mutate(workflow);
    assert.throws(() => validate(workflow), assert.AssertionError);
  });
}

const toolchainMutations = {
  'a mobile script calls another binary': ({ mobilePackage }) => {
    mobilePackage.scripts.build = mobilePackage.scripts.build.replace(/^eas /, 'eas-cli ');
  },
  'eas.json selects another CLI version': ({ mobilePackage, easConfig }) => {
    easConfig.cli.version = `${mobilePackage.devDependencies['eas-cli']}.1`;
  },
  'eas-cli is declared as a range': ({ mobilePackage }) => {
    mobilePackage.devDependencies['eas-cli'] = `^${mobilePackage.devDependencies['eas-cli']}`;
  },
  'a workflow step calls the CLI directly': ({ workflow }) => {
    const build = workflow.jobs['build-and-submit'].steps.find(item =>
      /\beas build\b/.test(item.run ?? '')
    );
    build.run = build.run.replace('pnpm exec eas build', 'eas build');
  },
  'a workflow step bypasses the installed CLI': ({ workflow, mobilePackage }) => {
    const build = workflow.jobs['build-and-submit'].steps.find(item =>
      /\beas build\b/.test(item.run ?? '')
    );
    build.run = build.run.replace(
      'pnpm exec eas build',
      `pnpx eas-cli@${mobilePackage.devDependencies['eas-cli']} build`
    );
  },
  'a mobile script bypasses the installed CLI': ({ mobilePackage }) => {
    mobilePackage.scripts.build = `pnpx eas-cli@${mobilePackage.devDependencies['eas-cli']} ${mobilePackage.scripts.build}`;
  },
  'the lockfile records another CLI version': ({ lockfile }) => {
    lockfile.importers['apps/mobile'].devDependencies['eas-cli'].version = '24.8.0';
  },
  'the lockfile records a range for the CLI': ({ lockfile, mobilePackage }) => {
    lockfile.importers['apps/mobile'].devDependencies['eas-cli'].specifier =
      `^${mobilePackage.devDependencies['eas-cli']}`;
  },
  'the lockfile drops the CLI package': ({ lockfile, mobilePackage }) => {
    delete lockfile.packages[`eas-cli@${mobilePackage.devDependencies['eas-cli']}`];
  },
};

for (const [name, mutate] of Object.entries(toolchainMutations)) {
  test(`the mobile toolchain validator rejects: ${name}`, () => {
    const workflow = readWorkflow();
    const mobilePackage = readJson(mobilePackagePath);
    const easConfig = readJson(easConfigPath);
    const lockfile = readLockfile();
    mutate({ workflow, mobilePackage, easConfig, lockfile });
    assert.throws(
      () => validateEasCli(workflow, mobilePackage, easConfig, lockfile),
      assert.AssertionError
    );
  });
}
