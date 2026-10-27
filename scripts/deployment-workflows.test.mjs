import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { load } from 'js-yaml';

function workflow(name) {
  return load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));
}

const production = workflow('deploy-production');
const staging = workflow('deploy-staging');
const gate = workflow('check-deployment-changes');
const workers = workflow('deploy-workers');
const ci = workflow('ci');

test('both Worker deployment paths prepare usage queues before direct consumer deployment', () => {
  for (const [job, selector] of [
    ['deploy-manual', 'inputs.worker'],
    ['deploy-changed', 'matrix.worker'],
  ]) {
    const steps = workers.jobs[job].steps;
    const checkIndex = steps.findIndex(step => step.id === 'usage_queues');
    const consumerIndex = steps.findIndex(step => step.name === 'Deploy to Cloudflare Workers');
    assert.ok(checkIndex > steps.findIndex(step => step.name === 'Install dependencies'));
    const prepareIndex = steps.findIndex(step => step.name === 'Prepare staging usage queues');
    assert.ok(checkIndex < prepareIndex && prepareIndex < consumerIndex);
    assert.equal(steps[prepareIndex].if, "steps.usage_queues.outputs.prepare_required == 'true'");
    assert.equal(
      steps[prepareIndex].env.CLOUDFLARE_API_TOKEN,
      '${{ secrets.CLOUDFLARE_API_TOKEN }}'
    );
    assert.equal(
      steps[checkIndex].if,
      `${selector} == 'services/usage-ingest' && inputs.target_environment == 'staging'`
    );
    assert.equal(steps[checkIndex]['working-directory'], 'services/usage-ingest');
    assert.equal(steps[checkIndex]['continue-on-error'], undefined);
    for (const [worker, environment, expected] of [
      ['services/usage-ingest', 'staging', true],
      ['services/usage-ingest', 'production', false],
      ['services/other-worker', 'staging', false],
      ['services/other-worker', 'production', false],
    ]) {
      assert.equal(
        runInNewContext(steps[checkIndex].if, {
          inputs: { worker, target_environment: environment },
          matrix: { worker },
        }),
        expected
      );
    }
    assert.equal(
      steps.some(step => step.with?.command?.includes('wrangler.writer-relay.jsonc')),
      false
    );
    assert.doesNotMatch(steps[consumerIndex].if, /always\(|failure\(/);
    assert.equal(
      steps[consumerIndex].with.command,
      "${{ steps.runtime.outputs.command || (inputs.target_environment == 'production' && 'deploy' || format('deploy --env {0}', inputs.target_environment)) }} " +
        "${{ steps.usage_queues.outputs.queues_required == 'true' && '--experimental-provision=false' || '' }}"
    );
  }
});

test('both upload attempts disable native provisioning only when EU preparation is required', () => {
  for (const job of ['deploy-manual', 'deploy-changed']) {
    const uploads = workers.jobs[job].steps.filter(step =>
      step.name?.startsWith('Deploy to Cloudflare Workers')
    );
    assert.equal(uploads.length, 2);
    for (const step of uploads) {
      const expression = step.with.command.match(/\$\{\{ (steps\.usage_queues.*?) \}\}$/)[1];
      for (const required of ['true', 'false', undefined]) {
        assert.equal(
          runInNewContext(expression, {
            steps: { usage_queues: { outputs: { queues_required: required } } },
          }),
          required === 'true' ? '--experimental-provision=false' : ''
        );
      }
    }
  }
});

test('selected source prepares queues and rejects retired relay sources before deployment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-queues-selected-source-'));
  try {
    // The selected source has no new helper script. Resolve only its pre-existing
    // Wrangler dependency, just as the workflow does after installing dependencies.
    symlinkSync(
      fileURLToPath(new URL('../services/usage-ingest/node_modules', import.meta.url)),
      join(directory, 'node_modules')
    );
    mkdirSync(join(directory, 'scripts'));
    const output = join(directory, 'output');
    const calls = join(directory, 'calls');
    for (const job of ['deploy-manual', 'deploy-changed']) {
      const check = workers.jobs[job].steps.find(step => step.id === 'usage_queues');
      const prepare = workers.jobs[job].steps.find(
        step => step.name === 'Prepare staging usage queues'
      );
      for (const scenario of [
        'historical-direct',
        'direct-unused-file',
        'historical-relay',
        'historical-relay-with-file',
        'eu',
        'eu-failure',
        'eu-missing-helper',
        'global',
        'global-failure',
        'renamed-failure',
      ]) {
        const eu = scenario.startsWith('eu');
        const prepared = eu || scenario.startsWith('global') || scenario === 'renamed-failure';
        const historicalRelay = scenario.startsWith('historical-relay');
        writeFileSync(
          join(directory, 'wrangler.jsonc'),
          JSON.stringify({
            name: 'usage-ingest',
            compatibility_date: '2026-09-18',
            env: {
              staging: {
                name: 'usage-ingest-staging',
                ...(prepared
                  ? {
                      queues: {
                        producers: [
                          {
                            binding: 'QUEUE',
                            queue: eu
                              ? 'test-eu'
                              : scenario === 'renamed-failure'
                                ? 'usage-ingest-renamed'
                                : 'usage-ingest-processing-staging',
                          },
                        ],
                      },
                    }
                  : {}),
                ...(historicalRelay
                  ? {
                      services: [
                        { binding: 'USAGE_WRITER_RELAY', service: 'usage-writer-relay-staging' },
                      ],
                    }
                  : {}),
              },
            },
          })
        );
        rmSync(join(directory, 'wrangler.writer-relay.jsonc'), { force: true });
        if (scenario === 'historical-relay-with-file' || scenario === 'direct-unused-file') {
          writeFileSync(join(directory, 'wrangler.writer-relay.jsonc'), '{}');
        }
        for (const path of ['scripts/provision-queues.mjs'])
          rmSync(join(directory, path), { force: true });
        if (prepared && scenario !== 'eu-missing-helper')
          writeFileSync(
            join(directory, 'scripts/provision-queues.mjs'),
            `
          import { appendFileSync } from 'node:fs';
          appendFileSync(process.env.DEPLOY_CALLS, 'prepare\\n');
        `
          );
        if (['eu-failure', 'global-failure', 'renamed-failure'].includes(scenario))
          writeFileSync(
            join(directory, 'scripts/provision-queues.mjs'),
            readFileSync(
              new URL('../services/usage-ingest/scripts/provision-queues.mjs', import.meta.url)
            )
          );
        writeFileSync(output, '');
        writeFileSync(calls, '');
        // Commands are local stand-ins for the pinned action's Wrangler calls.
        // Execute the workflow's actual check, preserving fail-fast sequencing.
        const result = spawnSync(
          'bash',
          [
            '-e',
            '-c',
            `
          wrangler() {
            printf '%s\\n' "$*" >> "$DEPLOY_CALLS"
          }
          ${check.run}
          if grep -q '^prepare_required=true$' "$GITHUB_OUTPUT"; then ${prepare.run}; fi
          wrangler deploy --env staging
        `,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              GITHUB_OUTPUT: output,
              DEPLOY_CALLS: calls,
              WRANGLER_SEND_METRICS: 'false',
              WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
            },
          }
        );
        const deployed = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
        if (
          ['eu-failure', 'eu-missing-helper', 'global-failure', 'renamed-failure'].includes(
            scenario
          )
        ) {
          assert.notEqual(result.status, 0, `${job} ${scenario}: preparation must stop upload`);
          assert.deepEqual(deployed, []);
        } else if (historicalRelay) {
          assert.notEqual(result.status, 0, `${job}: retired relay source must fail`);
          assert.match(result.stderr, /requires the retired usage writer relay/);
          assert.deepEqual(deployed, []);
        } else {
          assert.equal(result.status, 0, `${job} ${scenario}: ${result.stderr}`);
          assert.deepEqual(deployed, [...(prepared ? ['prepare'] : []), 'deploy --env staging']);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
    assert.equal(production.jobs[job].needs, 'check-changes');
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

test('both Worker deployment paths retry a deploy once', () => {
  // Cloudflare's upload validation rejected a script that it accepted with a
  // byte-identical bundle a moment earlier, so one retry stands between that
  // noise and a failed release.
  for (const name of ['deploy-manual', 'deploy-changed']) {
    const steps = workers.jobs[name].steps;
    const first = steps.findIndex(step => step.name === 'Deploy to Cloudflare Workers');
    assert.ok(first >= 0, `${name} must deploy the Worker`);
    assert.equal(steps[first].id, 'deploy');
    assert.equal(steps[first]['continue-on-error'], true);
    const retry = steps[first + 1];
    assert.equal(retry.name, 'Deploy to Cloudflare Workers (retry)');
    assert.equal(retry.if, "steps.deploy.outcome == 'failure'");
    assert.equal(retry.with.command, steps[first].with.command);
    assert.equal(retry.with.workingDirectory, steps[first].with.workingDirectory);
  }
});

test('production deploys cloud-agent-next after a changed session-ingest contract', () => {
  const detect = workers.jobs['detect-changes'];
  assert.equal(
    detect.outputs['deploy-cloud-agent-after-session-ingest'],
    '${{ steps.set-matrix.outputs.deploy-cloud-agent-after-session-ingest }}'
  );
  const ordered = workers.jobs['deploy-cloud-agent-after-session-ingest'];
  assert.equal(ordered.needs, 'detect-changes');
  assert.match(ordered.if, /deploy-cloud-agent-after-session-ingest == 'true'/);
  const wait = ordered.steps.find(step => step.name === 'Wait for session-ingest deployment');
  assert.match(wait.run, /Deploy services\/session-ingest/);
  assert.match(wait.run, /seq 1 360/);
  assert.match(wait.run, /queued/);
  assert.match(wait.run, /in_progress/);
  const prepare = ordered.steps.findIndex(step => step.id === 'runtime');
  const deploy = ordered.steps.findIndex(step => step.name === 'Deploy cloud-agent-next');
  assert.ok(prepare >= 0 && prepare < deploy);
  assert.equal(ordered.steps[deploy].with.preCommands, 'pnpm run predeploy');
  assert.equal(ordered.steps[deploy + 1].with.preCommands, 'pnpm run predeploy');
});
