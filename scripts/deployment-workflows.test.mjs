import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

function workflow(name) {
  return load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

const production = workflow('deploy-production');
const staging = workflow('deploy-staging');
const gate = workflow('check-deployment-changes');
const workers = workflow('deploy-workers');
const ci = workflow('ci');

test('production and staging schedule independently on main every 20 minutes', () => {
  for (const [name, deployment] of [
    ['production', production],
    ['staging', staging],
  ]) {
    assert.equal(deployment.on.push, undefined, `${name} must not deploy on every merge`);
    assert.deepEqual(deployment.on.schedule, [{ cron: '7,27,47 * * * *' }]);
    assert.ok(Object.hasOwn(deployment.on, 'workflow_dispatch'));
    assert.equal(deployment.concurrency['cancel-in-progress'], false);
    assert.equal(deployment.jobs['check-changes'].with.workflow_file, `deploy-${name}.yml`);
    assert.equal(deployment.jobs['check-changes'].needs, undefined);
  }
  assert.notEqual(production.concurrency.group, staging.concurrency.group);
});

test('successful main CI selects the tested deployment SHA', () => {
  const check = gate.jobs.check.steps.find(step => step.id === 'changes');
  assert.match(check.run, /--status success/);
  assert.match(check.run, /--workflow ci\.yml/);
  assert.match(check.run, /--event push/);
  assert.match(check.run, /--workflow "\$WORKFLOW_FILE"/);
  assert.match(check.run, /git merge-base --is-ancestor "\$sha" HEAD/);
  assert.match(check.run, /git hash-object -t tree \/dev\/null/);
  assert.match(check.run, /git merge-base --is-ancestor "\$base_sha" "\$target_sha"/);
  assert.match(
    check.run,
    /git diff --quiet "\$base_sha" "\$target_sha" -- \. ':\(exclude\)apps\/mobile'/
  );
  assert.match(check.run, /should_deploy=false/);
  assert.equal(gate.on.workflow_call.outputs.base_sha.value, '${{ jobs.check.outputs.base_sha }}');
  assert.equal(
    gate.on.workflow_call.outputs.target_sha.value,
    '${{ jobs.check.outputs.target_sha }}'
  );
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");

  for (const job of [
    'check-production-db-startup',
    'run-migrations',
    'stage-app',
    'stage-global-app',
  ]) {
    assert.equal(production.jobs[job].needs, 'check-changes');
    assert.match(production.jobs[job].if, /should_deploy == 'true'/);
  }
  for (const job of [
    'check-staging-db-startup',
    'run-migrations',
    'deploy-app',
    'deploy-global-app',
    'deploy-workers',
  ]) {
    assert.match(staging.jobs[job].if, /should_deploy == 'true'/);
    assert.ok([staging.jobs[job].needs].flat().includes('check-changes'));
  }
});

test('staging and production Worker changes use independent deployment baselines', () => {
  assert.equal(workers.concurrency.group, 'deploy-workers-${{ inputs.target_environment }}');
  assert.equal(
    production.jobs['deploy-workers'].with.base_sha,
    '${{ needs.check-changes.outputs.base_sha }}'
  );
  assert.equal(
    staging.jobs['deploy-workers'].with.base_sha,
    '${{ needs.check-changes.outputs.base_sha }}'
  );
  assert.equal(staging.jobs['deploy-workers'].with.target_environment, 'staging');
  assert.equal(
    staging.jobs['deploy-workers'].with.source_sha,
    '${{ needs.check-changes.outputs.target_sha }}'
  );
  assert.match(workers.jobs['detect-changes'].if, /inputs.base_sha != ''/);
  const detect = workers.jobs['detect-changes'].steps.find(step => step.id === 'set-matrix');
  assert.match(detect.run, /has_named_environment "\$dir\/wrangler\.jsonc"/);
  assert.match(
    detect.run,
    /git diff --quiet "\$BASE_SHA" HEAD -- "\$dir\/" packages pnpm-lock\.yaml/
  );
  assert.equal(
    production.jobs['deploy-kiloclaw'].if,
    "needs.check-changes.outputs.deploy_kiloclaw == 'true'"
  );
  for (const [name, deployment] of [
    ['production', production],
    ['staging', staging],
  ]) {
    assert.equal(deployment.jobs['record-deployment'].permissions.deployments, 'write');
    assert.match(
      deployment.jobs['record-deployment'].if,
      /needs\.deploy-workers\.result == 'success'/
    );
    assert.match(
      deployment.jobs['record-deployment'].steps[0].run,
      new RegExp(`scheduled-deploy-${name}`)
    );
    assert.equal(
      deployment.jobs['record-deployment'].steps[0].env.SOURCE_SHA,
      '${{ needs.check-changes.outputs.target_sha }}'
    );
  }
});

test('deployment gate only deploys changes since the last complete run', () => {
  const directory = mkdtempSync(join(tmpdir(), 'deployment-workflow-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const commit = message => {
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  };
  const runGate = (lastSuccessSha, ciSha = git('rev-parse', 'HEAD'), legacySha = '') => {
    const outputPath = join(directory, '.git', 'test-output');
    const summaryPath = join(directory, '.git', 'test-summary');
    writeFileSync(outputPath, '');
    writeFileSync(summaryPath, '');
    const script = gate.jobs.check.steps.find(step => step.id === 'changes').run;
    const result = spawnSync(
      'bash',
      [
        '-e',
        '-c',
        `gh() {
        if [ "$1" = run ]; then
          if [[ "$*" == *'--workflow ci.yml'* ]]; then
            printf '%s\\n' "$CI_SHA"
          else
            printf '%s\\n' "$LEGACY_SHA"
          fi
        elif [[ "$2" == *'/statuses?'* ]]; then
          printf 'success\\n'
        else
          printf '123\\t%s\\n' "$LAST_SUCCESS_SHA"
        fi
      }\n${script}`,
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_REPOSITORY: 'example/repo',
          LAST_SUCCESS_SHA: lastSuccessSha,
          CI_SHA: ciSha,
          LEGACY_SHA: legacySha,
          WORKFLOW_FILE: 'deploy-production.yml',
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(outputPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => line.split('='))
    );
  };

  try {
    git('init', '-q');
    for (const path of ['apps/mobile', 'apps/web', 'services/kiloclaw']) {
      mkdirSync(join(directory, path), { recursive: true });
      writeFileSync(join(directory, path, 'file'), 'initial');
    }
    commit('initial');
    const deployedSha = git('rev-parse', 'HEAD');
    assert.equal(runGate(deployedSha).should_deploy, 'false');

    writeFileSync(join(directory, 'apps/mobile/file'), 'mobile');
    commit('mobile');
    assert.equal(runGate(deployedSha).should_deploy, 'false');

    writeFileSync(join(directory, 'apps/web/file'), 'web');
    commit('web');
    assert.deepEqual(runGate(deployedSha), {
      base_sha: deployedSha,
      target_sha: git('rev-parse', 'HEAD'),
      should_deploy: 'true',
      deploy_kiloclaw: 'false',
    });
    assert.match(
      readFileSync(join(directory, '.git', 'test-summary'), 'utf8'),
      /Deploying candidate/
    );

    writeFileSync(join(directory, 'services/kiloclaw/file'), 'worker');
    commit('worker');
    assert.equal(runGate(deployedSha).deploy_kiloclaw, 'true');
    const greenSha = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'apps/web/file'), 'untested');
    commit('untested');
    assert.equal(runGate(deployedSha, greenSha).target_sha, greenSha);
    assert.equal(runGate(greenSha, greenSha).should_deploy, 'false');
    assert.equal(runGate(greenSha, deployedSha).should_deploy, 'false');
    assert.equal(runGate(deployedSha, '').should_deploy, 'false');
    assert.equal(runGate('', greenSha, deployedSha).base_sha, deployedSha);
    assert.equal(runGate('').should_deploy, 'true');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
