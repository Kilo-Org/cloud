import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

const workflowPath = '.github/workflows/kilo-app-release.yml';

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

  // The cost gate is the last thing before any build: every job that builds or
  // submits needs it, not only the build itself.
  for (const jobName of ['validate', 'preflight', 'build-and-submit', 'bump-version']) {
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
