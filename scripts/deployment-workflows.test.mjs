import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';
import { cloudAgentRuntimeChanged } from './cloud-agent-runtime-changes.mjs';

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
  assert.match(check.run, /find_latest_successful_main_push\(\)/);
  assert.match(check.run, /actions\/workflows\/\$workflow_file\/runs\?per_page=100&page=\$page/);
  assert.match(
    check.run,
    /sort_by\(\.created_at\) \| reverse \| \.\[\] \| select\(\.head_branch == "main" and \.event == "push" and \.status == "completed" and \.conclusion == "success"\)/
  );
  assert.match(check.run, /find_latest_successful_main_push ci\.yml HEAD/);
  assert.match(check.run, /find_latest_successful_main_push "\$WORKFLOW_FILE"/);
  assert.match(check.run, /\[ "\$run_count" -lt 100 \]/);
  assert.doesNotMatch(check.run, /gh run list/);
  assert.doesNotMatch(check.run, /--branch main/);
  assert.doesNotMatch(check.run, /--event push/);
  assert.doesNotMatch(check.run, /--status success/);
  assert.match(check.run, /git merge-base --is-ancestor "\$sha" "\$ancestor_ref"/);
  assert.match(check.run, /git hash-object -t tree \/dev\/null/);
  assert.match(check.run, /git merge-base --is-ancestor "\$base_sha" "\$target_sha"/);
  assert.match(
    check.run,
    /git diff --quiet "\$base_sha" "\$target_sha" -- \. ':\(exclude\)apps\/mobile'/
  );
  assert.match(check.run, /should_deploy=false/);
  assert.match(
    check.run,
    /CI-green candidate \\`\$target_sha\\` is already included in last completed release \\`\$base_sha\\`/
  );
  assert.equal(gate.on.workflow_call.outputs.base_sha.value, '${{ jobs.check.outputs.base_sha }}');
  assert.equal(
    gate.on.workflow_call.outputs.target_sha.value,
    '${{ jobs.check.outputs.target_sha }}'
  );
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");

  for (const job of ['check-production-db-startup', 'run-migrations', 'stage-app']) {
    assert.deepEqual(
      production.jobs[job].needs,
      job === 'run-migrations' ? ['check-changes', 'prepare-cloud-agent-runtime'] : 'check-changes'
    );
    assert.match(production.jobs[job].if, /should_deploy == 'true'/);
  }
  for (const job of [
    'check-staging-db-startup',
    'run-migrations',
    'deploy-app',
    'deploy-workers',
  ]) {
    assert.match(staging.jobs[job].if, /should_deploy == 'true'/);
    assert.ok([staging.jobs[job].needs].flat().includes('check-changes'));
  }
});

test('Cloud Agent release preparation gates migrations and binds both Worker deploy paths', () => {
  const release = workflow('cloud-agent-runtime-release');
  const admission = workflow('cloud-agent-runtime-admission');
  assert.deepEqual(Object.keys(release.on), ['workflow_call']);
  assert.deepEqual(Object.keys(admission.on), ['workflow_call']);
  assert.equal(release.permissions.contents, 'read');
  assert.equal(release.permissions.actions, 'read');
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.equal(release.jobs.release.needs, 'admit-source');
  assert.equal(
    release.jobs['admit-source'].uses,
    './.github/workflows/cloud-agent-runtime-admission.yml'
  );
  const guard = admission.jobs.admit.steps.map(step => step.run ?? '').join('\n');
  assert.match(guard, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(guard, /schedule\|workflow_dispatch/);
  assert.match(guard, /git merge-base --is-ancestor "\$SOURCE_SHA" origin\/main/);
  assert.match(guard, /head_sha=\$SOURCE_SHA/);
  assert.match(guard, /\.head_sha == .*\$SOURCE_SHA/);
  assert.match(guard, /\.event == \\"push\\"/);
  assert.match(guard, /\.conclusion == \\"success\\"/);
  const preparation = production.jobs['prepare-cloud-agent-runtime'];
  assert.equal(preparation.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
  assert.equal(preparation.with.base_sha, '${{ needs.check-changes.outputs.base_sha }}');
  assert.ok(production.jobs['run-migrations'].needs.includes('prepare-cloud-agent-runtime'));
  assert.ok(production.jobs['record-deployment'].needs.includes('prepare-cloud-agent-runtime'));
  assert.match(
    production.jobs['record-deployment'].if,
    /needs\.prepare-cloud-agent-runtime\.result == 'success'/
  );
  assert.equal(
    production.jobs['deploy-workers'].with.cloud_agent_runtime_artifact,
    '${{ needs.prepare-cloud-agent-runtime.outputs.artifact_name }}'
  );
  const releaseSteps = release.jobs.release.steps;
  const validateIndex = releaseSteps.findIndex(
    step => step.name === 'Validate release inputs and select Bun'
  );
  const publishIndex = releaseSteps.findIndex(
    step => step.name === 'Publish or reuse verified runtime candidates'
  );
  assert.ok(validateIndex >= 0 && validateIndex < publishIndex);
  assert.equal(releaseSteps[validateIndex].env.CLOUDFLARE_API_TOKEN, undefined);
  assert.match(releaseSteps[publishIndex].run, /runtime:release prepare/);
  assert.match(
    releaseSteps.find(step => step.id === 'changes').run,
    /node scripts\/cloud-agent-runtime-changes\.mjs "\$BASE_SHA" HEAD/
  );
  assert.match(
    workers.jobs['detect-changes'].steps.find(step => step.name === 'Find changed workers').run,
    /node scripts\/cloud-agent-runtime-changes\.mjs "\$BASE_SHA" HEAD/
  );
  assert.match(
    workers.jobs['prepare-cloud-agent-runtime'].if,
    /inputs\.worker == 'services\/cloud-agent-next'/
  );
  assert.doesNotMatch(workers.jobs['prepare-cloud-agent-runtime'].if, /inputs\.worker == ''/);
  for (const jobName of ['deploy-manual', 'deploy-changed']) {
    const job = workers.jobs[jobName];
    assert.ok(job.needs.includes('admit-cloud-agent-source'));
    assert.ok(job.needs.includes('prepare-cloud-agent-runtime'));
    const verification = job.steps.findIndex(
      step => step.name === 'Verify Cloud Agent release and deployment order'
    );
    const deployment = job.steps.findIndex(step =>
      step.uses?.startsWith('cloudflare/wrangler-action@')
    );
    assert.ok(verification >= 0 && verification < deployment);
    assert.match(job.steps[verification].run, /runtime:release verify/);
    assert.match(
      job.steps[deployment].with.command,
      /--config wrangler\.runtime-release\.json --tag runtime-ci-/
    );
    assert.equal(job.steps.find(step => step.name === 'Checkout code').with['fetch-depth'], 0);
  }
  const ciSteps = Object.values(ci.jobs).flatMap(job => job.steps ?? []);
  assert.ok(ciSteps.some(step => step.run?.includes('runtime:release validate')));
  const baseCheck = ciSteps.find(step => step.run?.includes('runtime:release check-base'));
  assert.equal(baseCheck.if, "steps.runtime_inputs.outputs.base_changed == 'true'");
});

test('Cloud Agent source admission rejects untrusted or untested sources and retains an older tested SHA', () => {
  const admission = workflow('cloud-agent-runtime-admission').jobs.admit.steps;
  const trustedScript = admission.find(step => step.name === 'Require trusted main execution').run;
  const greenScript = admission.find(
    step => step.name === 'Admit the exact CI-green main source'
  ).run;
  const root = mkdtempSync(join(tmpdir(), 'runtime-admission-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    writeFileSync(join(root, 'source.txt'), 'tested source');
    git('add', 'source.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'tested source'
    );
    const tested = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'source.txt'), 'main advanced');
    git('add', 'source.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'main advanced'
    );
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    git('checkout', '--detach', tested);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\ncase "$2" in *"head_sha=$SOURCE_SHA"*) ;; *) exit 1 ;; esac\nprintf "%s\\n" "$CI_ADMITTED"\n',
      { mode: 0o755 }
    );
    const environment = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REPOSITORY: 'fixture/cloud',
      SOURCE_SHA: tested,
      CI_ADMITTED: 'true',
    };
    const invoke = (script, overrides = {}) =>
      spawnSync('bash', ['-c', script], {
        cwd: root,
        env: { ...environment, ...overrides },
        encoding: 'utf8',
      });
    assert.equal(invoke(trustedScript).status, 0);
    assert.equal(invoke(greenScript).status, 0);
    assert.notEqual(invoke(trustedScript, { GITHUB_REF: 'refs/heads/feature' }).status, 0);
    assert.notEqual(invoke(trustedScript, { GITHUB_EVENT_NAME: 'pull_request' }).status, 0);
    assert.notEqual(invoke(trustedScript, { SOURCE_SHA: 'unsafe;source' }).status, 0);
    for (const CI_ADMITTED of ['false', ''])
      assert.notEqual(invoke(greenScript, { CI_ADMITTED }).status, 0);
    assert.notEqual(invoke(greenScript, { SOURCE_SHA: git('rev-parse', 'origin/main') }).status, 0);
    assert.equal(git('rev-parse', 'HEAD'), tested);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Cloud Agent change detection owns one complete deployment range and skips unrelated code', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-changes-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = message => {
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        message
      );
      return git('rev-parse', 'HEAD');
    };
    git('init', '-b', 'main');
    const directory = join(root, 'services/cloud-agent-next/wrapper/src');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'main.ts'), 'runtime-a');
    const baseline = commit('baseline');
    writeFileSync(join(root, 'unrelated.txt'), 'unrelated code');
    const unrelated = commit('unrelated');
    assert.equal(cloudAgentRuntimeChanged(baseline, unrelated, root), false);
    writeFileSync(join(directory, 'main.ts'), 'runtime-b');
    const runtime = commit('runtime change');
    writeFileSync(join(root, 'unrelated.txt'), 'another unrelated change');
    const target = commit('later unrelated commit');
    assert.equal(cloudAgentRuntimeChanged(baseline, target, root), true);
    assert.equal(cloudAgentRuntimeChanged(runtime, target, root), false);
    assert.equal(cloudAgentRuntimeChanged('', target, root), true);
    assert.throws(() => cloudAgentRuntimeChanged('invalid-ref', target, root), /Cannot compare/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the actual Worker matrix includes Cloud Agent changes and skips unrelated code and missing staging', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-worker-matrix-'));
  const matrixScript = workers.jobs['detect-changes'].steps.find(
    step => step.name === 'Find changed workers'
  ).run;
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const commit = message => {
      git('add', '.');
      git(
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        message
      );
      return git('rev-parse', 'HEAD');
    };
    git('init', '-b', 'main');
    mkdirSync(join(root, 'scripts'));
    writeFileSync(
      join(root, 'scripts/cloud-agent-runtime-changes.mjs'),
      readFileSync(new URL('./cloud-agent-runtime-changes.mjs', import.meta.url))
    );
    const cloud = join(root, 'services/cloud-agent-next');
    mkdirSync(cloud, { recursive: true });
    writeFileSync(join(cloud, 'wrangler.jsonc'), '{"name":"cloud-agent-next","env":{}}');
    writeFileSync(join(cloud, 'runtime.ts'), 'runtime-a');
    const other = join(root, 'services/other-worker');
    mkdirSync(other);
    writeFileSync(
      join(other, 'wrangler.jsonc'),
      '{"name":"other-worker","env":{"staging":{"name":"other-worker-staging"}}}'
    );
    writeFileSync(join(root, '.gitignore'), '.matrix-output\n');
    const baseline = commit('matrix baseline');
    const matrix = (base, environment = 'production') => {
      const output = join(root, '.matrix-output');
      writeFileSync(output, '');
      const script = matrixScript
        .replaceAll('${{ inputs.base_sha }}', base)
        .replaceAll('${{ inputs.target_environment }}', environment);
      const result = spawnSync('bash', ['-e', '-c', script], {
        cwd: root,
        env: { ...process.env, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const value = readFileSync(output, 'utf8')
        .split('\n')
        .find(line => line.startsWith('matrix='));
      assert.ok(value, 'matrix output must exist');
      return JSON.parse(value.slice('matrix='.length));
    };
    writeFileSync(join(root, 'unrelated.txt'), 'unrelated');
    commit('unrelated change');
    assert.deepEqual(matrix(baseline), []);
    writeFileSync(join(cloud, 'runtime.ts'), 'runtime-b');
    const runtime = commit('Cloud Agent changed');
    assert.deepEqual(matrix(baseline), ['services/cloud-agent-next']);
    assert.deepEqual(matrix(baseline, 'staging'), []);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/cloud-agent-runtime-admission.yml'),
      'source admission change'
    );
    commit('release policy changed');
    assert.deepEqual(matrix(runtime), ['services/cloud-agent-next']);
    const output = join(root, '.matrix-output');
    const failingScript = matrixScript
      .replaceAll('${{ inputs.base_sha }}', 'invalid-ref')
      .replaceAll('${{ inputs.target_environment }}', 'production');
    writeFileSync(output, '');
    const failed = spawnSync('bash', ['-e', '-c', failingScript], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
    rmSync(join(root, 'scripts/cloud-agent-runtime-changes.mjs'));
    const missing = spawnSync('bash', ['-e', '-c', failingScript], {
      cwd: root,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.notEqual(missing.status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ai-gateway deploys with each scheduled release after migrations', () => {
  const stageAiGateway = production.jobs['stage-ai-gateway'];
  assert.equal(stageAiGateway.needs, 'check-changes');
  assert.match(stageAiGateway.if, /should_deploy == 'true'/);
  assert.equal(stageAiGateway.with.target_environment, 'production');
  assert.equal(stageAiGateway.with.vercel_project_id_var, 'VERCEL_PROJECT_ID_AI_GATEWAY');
  assert.equal(stageAiGateway.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
  assert.equal(
    stageAiGateway.secrets.VERCEL_PROJECT_TOKEN,
    '${{ secrets.VERCEL_TOKEN_AI_GATEWAY }}'
  );

  const promoteAiGateway = production.jobs['promote-ai-gateway'];
  assert.deepEqual(promoteAiGateway.needs, [
    'stage-ai-gateway',
    'check-production-db-startup',
    'run-migrations',
  ]);
  assert.deepEqual(promoteAiGateway.with, {
    deployment_url: '${{ needs.stage-ai-gateway.outputs.deployment_url }}',
    axiom_annotation_dataset: 'vercel',
    axiom_expected_project: 'kilocode-ai-gateway',
  });
  assert.equal(
    promoteAiGateway.secrets.AXIOM_ANNOTATION_TOKEN,
    '${{ secrets.AXIOM_ANNOTATION_TOKEN }}'
  );

  const deployAiGateway = staging.jobs['deploy-ai-gateway'];
  assert.deepEqual(deployAiGateway.needs, [
    'check-changes',
    'check-staging-db-startup',
    'run-migrations',
  ]);
  assert.equal(deployAiGateway.with.target_environment, 'staging');
  assert.equal(deployAiGateway.with.vercel_project_id_var, 'VERCEL_PROJECT_ID_AI_GATEWAY');
  assert.equal(deployAiGateway.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
  assert.equal(
    deployAiGateway.secrets.VERCEL_PROJECT_TOKEN,
    '${{ secrets.VERCEL_TOKEN_AI_GATEWAY }}'
  );

  for (const job of ['deploy-workers', 'deploy-gastown-wasteland']) {
    for (const dependency of ['stage-ai-gateway', 'promote-ai-gateway']) {
      assert.ok(production.jobs[job].needs.includes(dependency), `${job} needs ${dependency}`);
      assert.match(production.jobs[job].if, new RegExp(`needs\\.${dependency}\\.result`));
    }
  }
  assert.ok(staging.jobs['deploy-workers'].needs.includes('deploy-ai-gateway'));

  for (const [deployment, jobs] of [
    [production, ['stage-ai-gateway', 'promote-ai-gateway']],
    [staging, ['deploy-ai-gateway']],
  ]) {
    const record = deployment.jobs['record-deployment'];
    for (const job of jobs) {
      assert.ok(record.needs.includes(job));
      assert.match(record.if, new RegExp(`needs\\.${job}\\.result == 'success'`));
    }
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
    production.jobs['deploy-kiloclaw'],
    undefined,
    'production must not run deploy-kiloclaw on the schedule: dispatch it manually'
  );
  assert.doesNotMatch(
    production.jobs['record-deployment'].if,
    /deploy-kiloclaw/,
    'production record-deployment must not wait on the manual kiloclaw deploy'
  );
  const kiloclaw = workflow('deploy-kiloclaw');
  assert.ok(
    Object.hasOwn(kiloclaw.on, 'workflow_dispatch'),
    'deploy-kiloclaw must be dispatchable manually'
  );
  assert.ok(Object.hasOwn(kiloclaw.on.workflow_dispatch.inputs, 'source_sha'));
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
  const runs = (...entries) => ({ workflow_runs: entries });
  const pages = (...entries) =>
    JSON.stringify(Object.fromEntries(entries.map(([page, value]) => [page, value])));
  const successfulMainPush = headSha => ({
    id: 1,
    head_sha: headSha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-29T20:14:27Z',
  });
  let lastSummary = '';
  const runGate = (
    lastSuccessSha,
    ciRuns = pages(['1', runs(successfulMainPush(git('rev-parse', 'HEAD')))]),
    legacyRuns = pages(['1', runs()]),
    failLookup = ''
  ) => {
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
        if [ "$1" = api ] && [[ "$2" == *'actions/workflows/ci.yml/runs?'* ]]; then
          page="\${2##*page=}"
          if [ "$FAIL_LOOKUP" = "ci:$page" ]; then
            return 1
          fi
          jq -c --arg page "$page" '.[$page]' <<< "$CI_RUNS"
        elif [ "$1" = api ] && [[ "$2" == *'actions/workflows/'*'/runs?'* ]]; then
          page="\${2##*page=}"
          if [ "$FAIL_LOOKUP" = "legacy:$page" ]; then
            return 1
          fi
          jq -c --arg page "$page" '.[$page]' <<< "$LEGACY_RUNS"
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
          CI_RUNS: ciRuns,
          LEGACY_RUNS: legacyRuns,
          FAIL_LOOKUP: failLookup,
          WORKFLOW_FILE: 'deploy-production.yml',
        },
      }
    );
    if (failLookup) {
      assert.notEqual(result.status, 0, result.stderr);
      return {};
    }
    assert.equal(result.status, 0, result.stderr);
    lastSummary = readFileSync(summaryPath, 'utf8');
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
    const kiloclawSha = git('rev-parse', 'HEAD');
    mkdirSync(join(directory, 'packages/kiloclaw-secret-catalog'), { recursive: true });
    writeFileSync(join(directory, 'packages/kiloclaw-secret-catalog/file'), 'shared package');
    commit('shared package');
    assert.equal(runGate(kiloclawSha).deploy_kiloclaw, 'true');
    const greenSha = git('rev-parse', 'HEAD');
    writeFileSync(join(directory, 'apps/web/file'), 'untested');
    commit('untested');
    const unrelatedRuns = Array.from({ length: 100 }, (_, index) => ({
      ...successfulMainPush(`unrelated-${index}`),
      head_branch: 'feature',
      created_at: `2026-09-29T20:${String(59 - (index % 60)).padStart(2, '0')}:00Z`,
    }));
    unrelatedRuns[0] = {
      ...successfulMainPush('pending'),
      status: 'in_progress',
      created_at: '2026-09-29T20:59:00Z',
    };
    unrelatedRuns[1] = {
      ...successfulMainPush('failed'),
      conclusion: 'failure',
      created_at: '2026-09-29T20:58:00Z',
    };
    unrelatedRuns[2] = {
      ...successfulMainPush('pull-request'),
      event: 'pull_request',
      created_at: '2026-09-29T20:57:00Z',
    };
    const ciRuns = pages(
      ['1', runs(...unrelatedRuns)],
      [
        '2',
        runs(
          {
            ...successfulMainPush('pending'),
            status: 'in_progress',
            created_at: '2026-09-29T20:20:00Z',
          },
          {
            ...successfulMainPush('failed'),
            conclusion: 'failure',
            created_at: '2026-09-29T20:19:00Z',
          },
          {
            ...successfulMainPush('pull-request'),
            event: 'pull_request',
            created_at: '2026-09-29T20:18:00Z',
          },
          {
            ...successfulMainPush('feature'),
            head_branch: 'feature',
            created_at: '2026-09-29T20:17:00Z',
          },
          { ...successfulMainPush(deployedSha), created_at: '2026-09-29T20:13:00Z' },
          { ...successfulMainPush(greenSha), created_at: '2026-09-29T20:16:00Z' }
        ),
      ]
    );
    assert.equal(runGate(deployedSha, ciRuns).target_sha, greenSha);
    assert.equal(runGate(greenSha, ciRuns).should_deploy, 'false');
    assert.equal(
      runGate(greenSha, pages(['1', runs(successfulMainPush(deployedSha))])).should_deploy,
      'false'
    );
    assert.match(
      lastSummary,
      new RegExp(
        'candidate `' +
          deployedSha +
          '` is already included in last completed release `' +
          greenSha +
          '`'
      )
    );
    assert.equal(runGate(deployedSha, pages(['1', runs()])).should_deploy, 'false');
    const nonReleaseRuns = Array.from({ length: 100 }, (_, index) => ({
      ...successfulMainPush(git('rev-parse', 'HEAD')),
      event: index % 2 === 0 ? 'schedule' : 'workflow_dispatch',
    }));
    assert.equal(
      runGate(
        '',
        ciRuns,
        pages(['1', runs(...nonReleaseRuns)], ['2', runs(successfulMainPush(deployedSha))])
      ).base_sha,
      deployedSha
    );
    assert.equal(
      runGate('', ciRuns, pages(['1', runs(...nonReleaseRuns)], ['2', runs()])).base_sha,
      git('hash-object', '-t', 'tree', '/dev/null')
    );
    runGate(deployedSha, pages(['1', runs(...unrelatedRuns)]), pages(), 'ci:2');
    runGate('', ciRuns, pages(['1', runs(...unrelatedRuns)]), 'legacy:2');
    assert.equal(
      runGate(
        '',
        ciRuns,
        pages([
          '1',
          runs(
            { ...successfulMainPush(greenSha), created_at: '2026-09-29T20:16:00Z' },
            { ...successfulMainPush(deployedSha), created_at: '2026-09-29T20:13:00Z' }
          ),
        ])
      ).base_sha,
      greenSha
    );
    assert.equal(runGate('').should_deploy, 'true');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
