import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

// The kilo-app release workflow wires two release scripts (sibling slice s1) into
// the pipeline: `kilo-app-release-notes.mjs` writes one changelog section per
// build, and `kilo-app-release-upload-cap.mjs` holds a run that Apple's rolling
// upload limit would refuse. Every check below sits beside a mutation applied to
// a parsed copy, so a dropped gate, a moved step or a wrong destination fails
// this suite instead of a real release.

const workflowPath = '.github/workflows/kilo-app-release.yml';

function readWorkflow() {
  return load(readFileSync(new URL(`../${workflowPath}`, import.meta.url), 'utf8'));
}

function step(workflow, jobName, id) {
  return workflow.jobs[jobName].steps.find(item => item.id === id);
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
  const pending = step(workflow, 'bump-version', 'pending');
  assert.match(pending.run, /headRefName/, 'the pending step must capture the open PR head branch');
  // The branch name is a PR head ref, so a stranger can choose it. It is checked
  // here, before the pipeline hands it to the changelog job.
  assert.match(
    pending.run,
    /grep -qE '\^kilo-app-version-bump-\[0-9\.\]\+\$'/,
    'the pending step must reject a branch this pipeline did not create'
  );
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
  'the pending step does not capture the branch name': workflow => {
    const pending = step(workflow, 'bump-version', 'pending');
    pending.run = pending.run.replaceAll('headRefName', 'headRef');
  },
  'the created branch is not recorded': workflow => {
    const bump = step(workflow, 'bump-version', 'bump');
    bump.run = bump.run.replace('branch=kilo-app-version-bump-$NEW', '');
  },
  'the pending step accepts any branch': workflow => {
    const pending = step(workflow, 'bump-version', 'pending');
    pending.run = pending.run.replace(
      "grep -qE '^kilo-app-version-bump-[0-9.]+$'",
      "grep -qE '^kilo-app-version-bump-'"
    );
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
