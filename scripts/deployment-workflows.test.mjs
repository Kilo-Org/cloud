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
    const prepareIndex = steps.findIndex(step => step.name === 'Prepare usage queues');
    assert.ok(checkIndex < prepareIndex && prepareIndex < consumerIndex);
    assert.equal(steps[prepareIndex].if, "steps.usage_queues.outputs.prepare_required == 'true'");
    assert.equal(
      steps[prepareIndex].env.CLOUDFLARE_API_TOKEN,
      '${{ secrets.CLOUDFLARE_API_TOKEN }}'
    );
    assert.equal(steps[prepareIndex].env.TARGET_ENVIRONMENT, '${{ inputs.target_environment }}');
    assert.equal(steps[checkIndex].env.TARGET_ENVIRONMENT, '${{ inputs.target_environment }}');
    assert.equal(
      steps[prepareIndex].run,
      'node scripts/provision-queues.mjs "$TARGET_ENVIRONMENT"'
    );
    assert.equal(
      steps[checkIndex].if,
      `${selector} == 'services/usage-ingest' && (inputs.target_environment == 'staging' || inputs.target_environment == 'production')`
    );
    assert.equal(steps[checkIndex]['working-directory'], 'services/usage-ingest');
    assert.equal(steps[checkIndex]['continue-on-error'], undefined);
    for (const [worker, environment, expected] of [
      ['services/usage-ingest', 'staging', true],
      ['services/usage-ingest', 'production', true],
      ['services/other-worker', 'staging', false],
      ['services/other-worker', 'production', false],
      ['services/usage-ingest', 'preview', false],
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
      const prepare = workers.jobs[job].steps.find(step => step.name === 'Prepare usage queues');
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
              TARGET_ENVIRONMENT: 'staging',
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

test('production EU preparation, rollback and historical source use the selected helper capability', () => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-production-selected-source-'));
  try {
    symlinkSync(
      fileURLToPath(new URL('../services/usage-ingest/node_modules', import.meta.url)),
      join(directory, 'node_modules')
    );
    mkdirSync(join(directory, 'scripts'));
    const output = join(directory, 'output');
    const calls = join(directory, 'calls');
    const helper = join(directory, 'scripts/provision-queues.mjs');
    for (const job of ['deploy-manual', 'deploy-changed']) {
      const check = workers.jobs[job].steps.find(step => step.id === 'usage_queues');
      const prepare = workers.jobs[job].steps.find(step => step.name === 'Prepare usage queues');
      for (const scenario of [
        'legacy-missing',
        'legacy-staging-only',
        'legacy-retired-relay',
        'eu',
        'global-rollback',
        'eu-missing',
        'eu-staging-only',
        'eu-invalid',
        'renamed-invalid',
      ]) {
        const eu = scenario.startsWith('eu');
        const current = ['eu', 'global-rollback', 'eu-invalid', 'renamed-invalid'].includes(
          scenario
        );
        writeFileSync(
          join(directory, 'wrangler.jsonc'),
          JSON.stringify({
            name: 'usage-ingest',
            compatibility_date: '2026-09-18',
            ...(scenario === 'legacy-retired-relay'
              ? {
                  services: [
                    { binding: 'USAGE_WRITER_RELAY', service: 'usage-writer-relay-staging' },
                  ],
                }
              : {}),
            queues: {
              producers: [
                {
                  binding: 'USAGE_INGEST_QUEUE',
                  queue: eu
                    ? 'usage-ingest-processing-eu'
                    : scenario === 'renamed-invalid'
                      ? 'usage-ingest-renamed'
                      : 'usage-ingest-processing',
                },
              ],
            },
          })
        );
        rmSync(helper, { force: true });
        if (current)
          writeFileSync(
            helper,
            `
          import { appendFileSync } from 'node:fs';
          export const supportedEnvironments = ['staging', 'production'];
          if (process.argv[1]) appendFileSync(process.env.DEPLOY_CALLS, 'prepare production\\n');
        `
          );
        if (scenario.endsWith('staging-only'))
          writeFileSync(
            helper,
            `
          export async function prepareQueues() {}
          if (process.argv[1]) throw new Error('Historical helper supports staging only');
        `
          );
        if (scenario.endsWith('invalid'))
          writeFileSync(
            helper,
            readFileSync(
              new URL('../services/usage-ingest/scripts/provision-queues.mjs', import.meta.url)
            )
          );
        writeFileSync(output, '');
        writeFileSync(calls, '');
        const result = spawnSync(
          'bash',
          [
            '-e',
            '-c',
            `
          wrangler() { printf '%s\\n' "$*" >> "$DEPLOY_CALLS"; }
          ${check.run}
          if grep -q '^prepare_required=true$' "$GITHUB_OUTPUT"; then ${prepare.run}; fi
          flag=''
          if grep -q '^queues_required=true$' "$GITHUB_OUTPUT"; then flag='--experimental-provision=false'; fi
          wrangler deploy $flag
        `,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            env: {
              ...process.env,
              TARGET_ENVIRONMENT: 'production',
              GITHUB_OUTPUT: output,
              DEPLOY_CALLS: calls,
              WRANGLER_SEND_METRICS: 'false',
              WRANGLER_LOG_PATH: join(directory, 'wrangler.log'),
            },
          }
        );
        const deployed = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
        if (
          [
            'eu-missing',
            'eu-staging-only',
            'eu-invalid',
            'renamed-invalid',
            'legacy-retired-relay',
          ].includes(scenario)
        ) {
          assert.notEqual(result.status, 0, `${job} ${scenario}: must fail before upload`);
          assert.deepEqual(deployed, []);
        } else {
          assert.equal(result.status, 0, `${job} ${scenario}: ${result.stderr}`);
          assert.deepEqual(deployed, [
            ...(current ? ['prepare production'] : []),
            `deploy${eu ? ' --experimental-provision=false' : ''}`,
          ]);
          assert.doesNotMatch(
            readFileSync(output, 'utf8'),
            /^required=/m,
            'retired relay output is absent'
          );
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('both deploys start from a successful main CI run and keep an hourly catch-up poll', () => {
  for (const [name, deployment] of [
    ['production', production],
    ['staging', staging],
  ]) {
    assert.equal(deployment.on.push, undefined, `${name} must not deploy on every merge`);
    assert.deepEqual(deployment.on.workflow_run, {
      workflows: [ci.name],
      types: ['completed'],
      branches: ['main'],
    });
    assert.deepEqual(deployment.on.schedule, [{ cron: '7 * * * *' }]);
    assert.ok(Object.hasOwn(deployment.on, 'workflow_dispatch'));
    assert.equal(deployment.concurrency['cancel-in-progress'], false);
    assert.equal(deployment.jobs['check-changes'].with.workflow_file, `deploy-${name}.yml`);
    // One runner reservation per run: the admission guard lives on the job that
    // does the candidate lookup, so no guard-only job reserves a runner first.
    assert.equal(deployment.jobs['check-changes'].needs, undefined);
    assert.equal(
      Object.hasOwn(deployment.jobs, 'admit'),
      false,
      `${name} must not reserve a runner to evaluate the guard`
    );
    const admitted = (eventName, conclusion, repository = 'Kilo-Org/cloud') =>
      runInNewContext(deployment.jobs['check-changes'].if, {
        github: {
          repository,
          event_name: eventName,
          event: { workflow_run: { conclusion } },
        },
      });
    assert.equal(admitted('workflow_run', 'success'), true);
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null]) {
      assert.equal(admitted('workflow_run', conclusion), false, `${name} must skip ${conclusion}`);
    }
    assert.equal(admitted('schedule', null), true);
    assert.equal(admitted('workflow_dispatch', null), true);
    for (const eventName of ['workflow_run', 'schedule', 'workflow_dispatch']) {
      assert.equal(
        admitted(eventName, 'success', 'fork/cloud'),
        false,
        `${name} must skip a fork's ${eventName}`
      );
    }
    // Every deploy job reaches the guarded job through `needs`, so a skipped
    // admission skips the whole chain exactly as the separate job did.
    const reachesCheckChanges = id => {
      const seen = new Set([id]);
      const pending = [deployment.jobs[id]];
      while (pending.length > 0) {
        for (const dependency of [pending.pop().needs ?? []].flat()) {
          if (dependency === 'check-changes') return true;
          if (seen.has(dependency)) continue;
          seen.add(dependency);
          pending.push(deployment.jobs[dependency]);
        }
      }
      return false;
    };
    assert.deepEqual(
      Object.entries(deployment.jobs)
        .filter(([, job]) => job.needs === undefined)
        .map(([id]) => id),
      ['check-changes'],
      `${name} must admit the trigger in the job that starts the candidate lookup`
    );
    for (const id of Object.keys(deployment.jobs).filter(id => id !== 'check-changes')) {
      assert.ok(reachesCheckChanges(id), `${id} must run only after the guarded lookup`);
    }
    assert.doesNotMatch(
      JSON.stringify(deployment.jobs),
      /workflow_run\.head_sha/,
      `${name} must not deploy a SHA taken from the event payload`
    );
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

  for (const job of ['db-gate', 'stage-app']) {
    assert.equal(production.jobs[job].needs, 'check-changes');
    assert.match(production.jobs[job].if, /should_deploy == 'true'/);
  }
  for (const job of ['db-gate', 'deploy-app', 'deploy-workers']) {
    assert.match(staging.jobs[job].if, /should_deploy == 'true'/);
    assert.ok([staging.jobs[job].needs].flat().includes('check-changes'));
  }
});

test('web promotion waits for a completed or deliberately skipped gateway rollout', () => {
  const job = production.jobs['promote-app'];
  const condition = (job.if ?? 'success()')
    .replace(/^\$\{\{|\}\}$/g, '')
    .replace(/needs\.([\w-]+)\.result/g, 'needs["$1"].result');
  const expression = /\b(always|cancelled|failure|success)\(/.test(condition)
    ? condition
    : `success() && (${condition})`;
  for (const [stage, promotion, app, database, cancelled, expected] of [
    ['success', 'success', 'success', 'success', false, true],
    ['skipped', 'skipped', 'success', 'success', false, true],
    ['success', 'failure', 'success', 'success', false, false],
    ['failure', 'skipped', 'success', 'success', false, false],
    ['cancelled', 'skipped', 'success', 'success', false, false],
    ['success', 'cancelled', 'success', 'success', false, false],
    ['success', 'skipped', 'success', 'success', false, false],
    ['skipped', 'success', 'success', 'success', false, false],
    ['skipped', 'skipped', 'failure', 'success', false, false],
    ['success', 'success', 'success', 'failure', false, false],
    ['skipped', 'skipped', 'success', 'skipped', false, false],
    ['success', 'success', 'success', 'success', true, false],
  ]) {
    const results = {
      'stage-app': app,
      'db-gate': database,
      'stage-ai-gateway': stage,
      'promote-ai-gateway': promotion,
    };
    const needs = Object.fromEntries(job.needs.map(name => [name, { result: results[name] }]));
    assert.equal(
      runInNewContext(expression, {
        needs,
        github: { repository: 'Kilo-Org/cloud' },
        cancelled: () => cancelled,
        success: () => Object.values(needs).every(dependency => dependency.result === 'success'),
      }),
      expected,
      JSON.stringify({ stage, promotion, app, database, cancelled })
    );
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
  assert.deepEqual(promoteAiGateway.needs, ['stage-ai-gateway', 'db-gate']);
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
  assert.deepEqual(deployAiGateway.needs, ['check-changes', 'db-gate']);
  assert.equal(deployAiGateway.with.target_environment, 'staging');
  assert.equal(deployAiGateway.with.vercel_project_id_var, 'VERCEL_PROJECT_ID_AI_GATEWAY');
  assert.equal(deployAiGateway.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
  assert.equal(
    deployAiGateway.secrets.VERCEL_PROJECT_TOKEN,
    '${{ secrets.VERCEL_TOKEN_AI_GATEWAY }}'
  );

  for (const job of ['deploy-workers']) {
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

test('one database gate per deployment checks out, installs and migrates once', () => {
  const dbGateInstall =
    "pnpm install --frozen-lockfile --filter '@kilocode/db...' --filter kilocode-monorepo";
  // The deploy gate narrows its install to the workspace set the CI drizzle
  // check already proves: the probe and drizzle-kit both resolve there.
  const ciDrizzleInstall = ci.jobs['drizzle-check'].steps.find(
    step => step.name === 'Install dependencies'
  ).run;
  assert.equal(dbGateInstall, ciDrizzleInstall);

  for (const [name, deployment, startupStep, migrateStep, environment] of [
    [
      'production',
      production,
      'Check production DB startup path',
      'Run Drizzle migrations',
      'production',
    ],
    ['staging', staging, 'Check staging DB startup path', 'Run Drizzle migrations', 'staging'],
  ]) {
    const dbJobs = Object.keys(deployment.jobs).filter(
      job => !deployment.jobs[job].uses && deployment.jobs[job].env?.POSTGRES_URL
    );
    assert.deepEqual(dbJobs, ['db-gate'], `${name} must gate the database with one job`);

    const job = deployment.jobs['db-gate'];
    assert.equal(job.environment, environment);
    assert.equal(job.env.POSTGRES_URL, '${{ secrets.POSTGRES_URL }}');
    assert.equal(job.env.DATABASE_CA, '${{ secrets.DATABASE_CA }}');

    const steps = job.steps;
    assert.equal(steps.filter(step => step.uses?.startsWith('useblacksmith/checkout@')).length, 1);
    assert.equal(steps.filter(step => step.run === dbGateInstall).length, 1);
    assert.equal(
      steps.find(step => step.uses?.startsWith('useblacksmith/checkout@')).with.ref,
      '${{ needs.check-changes.outputs.target_sha }}'
    );

    const startupIndex = steps.findIndex(step => step.name === startupStep);
    const migrateIndex = steps.findIndex(step => step.name === migrateStep);
    const installIndex = steps.findIndex(step => step.run === dbGateInstall);
    assert.ok(installIndex < startupIndex && startupIndex < migrateIndex);
    assert.match(steps[startupIndex].run, /scripts\/check-production-db-startup\.ts/);
    assert.equal(steps[migrateIndex].run, 'NODE_ENV=production pnpm run drizzle migrate');
    assert.equal(steps[migrateIndex].if, undefined);
  }

  assert.equal(production.jobs['db-gate']['timeout-minutes'], 45);

  for (const [deployment, jobs] of [
    [production, ['promote-app', 'promote-ai-gateway', 'deploy-workers', 'record-deployment']],
    [staging, ['deploy-app', 'deploy-ai-gateway', 'deploy-workers', 'record-deployment']],
  ]) {
    for (const job of jobs) {
      assert.ok(deployment.jobs[job].needs.includes('db-gate'), `${job} must wait for db-gate`);
    }
  }
  // Production also tolerates skipped staging jobs, so its Worker deploy names the
  // gate result explicitly; staging relies on the default needs-success behaviour.
  for (const job of ['deploy-workers', 'record-deployment']) {
    assert.match(production.jobs[job].if, /needs\.db-gate\.result == 'success'/);
  }
  assert.match(staging.jobs['record-deployment'].if, /needs\.db-gate\.result == 'success'/);
});

test('every Worker deploy job installs only the Worker closure and the root project', () => {
  // A recursive workspace install from inside a Worker links every unrelated
  // project and runs its lifecycle scripts once per deploy job. The closure
  // install links the Worker, its workspace dependencies, the root project and,
  // where the Worker builds the nested wrapper package, that package too.
  for (const [job, workingDirectory] of [
    ['deploy-manual', '${{ inputs.worker }}'],
    ['deploy-changed', '${{ matrix.worker }}'],
    ['deploy-session-ingest', 'services/session-ingest'],
    ['deploy-cloud-agent-after-session-ingest', 'services/cloud-agent-next'],
  ]) {
    const installs = workers.jobs[job].steps.filter(step =>
      (step.run ?? '').includes('pnpm install')
    );
    assert.equal(installs.length, 1, `${job} installs once`);
    assert.equal(installs[0]['working-directory'], workingDirectory);
    const run = installs[0].run;
    assert.ok(run.includes("filters=(--filter '{.}...' --filter kilocode-monorepo)"), job);
    assert.ok(run.includes('if [ -f wrapper/package.json ]; then'), job);
    assert.ok(run.includes("filters+=(--filter '@kilocode/cloud-agent-wrapper...')"), job);
    assert.ok(run.includes('pnpm install --frozen-lockfile "${filters[@]}"'), job);
    assert.ok(!run.includes('pnpm install --frozen-lockfile\n'), job);
  }

  // The change-detection job installs the root project alone: it only runs the
  // lockfile-dependent scripts that the root dependencies provide.
  assert.equal(
    workers.jobs['detect-changes'].steps.find(step => step.name === 'Install root dependencies')
      .run,
    'pnpm --filter kilocode-monorepo install --frozen-lockfile --ignore-scripts'
  );
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

test('every Worker deployment path retries a deploy once', () => {
  // Cloudflare's upload validation rejected a script that it accepted with a
  // byte-identical bundle a moment earlier, so one retry stands between that
  // noise and a failed release.
  for (const [name, deployName, deployId] of [
    ['deploy-manual', 'Deploy to Cloudflare Workers', 'deploy'],
    ['deploy-changed', 'Deploy to Cloudflare Workers', 'deploy'],
    ['deploy-session-ingest', 'Deploy to Cloudflare Workers', 'deploy'],
    ['deploy-cloud-agent-after-session-ingest', 'Deploy cloud-agent-next', 'deploy-cloud-agent'],
  ]) {
    const steps = workers.jobs[name].steps;
    const first = steps.findIndex(step => step.name === deployName);
    assert.ok(first >= 0, `${name} must deploy the Worker`);
    assert.equal(steps[first].id, deployId);
    assert.equal(steps[first]['continue-on-error'], true);
    const retry = steps[first + 1];
    assert.equal(retry.name, `${deployName} (retry)`);
    assert.equal(retry.if, `steps.${deployId}.outcome == 'failure'`);
    assert.equal(retry.with.command, steps[first].with.command);
    assert.equal(retry.with.workingDirectory, steps[first].with.workingDirectory);
  }
});

test('production deploys cloud-agent-next after the session-ingest job', () => {
  const detect = workers.jobs['detect-changes'];
  assert.equal(
    detect.outputs['deploy-cloud-agent-after-session-ingest'],
    '${{ steps.set-matrix.outputs.deploy-cloud-agent-after-session-ingest }}'
  );

  const ingest = workers.jobs['deploy-session-ingest'];
  assert.equal(ingest.needs, 'detect-changes');
  assert.equal(
    ingest.if,
    "github.repository == 'Kilo-Org/cloud' && needs.detect-changes.outputs.deploy-cloud-agent-after-session-ingest == 'true'"
  );
  assert.equal(ingest.environment, '${{ inputs.target_environment }}');
  assert.equal(ingest['timeout-minutes'], 25);

  const ordered = workers.jobs['deploy-cloud-agent-after-session-ingest'];
  assert.deepEqual([ordered.needs].flat(), ['detect-changes', 'deploy-session-ingest']);
  assert.match(ordered.if, /deploy-cloud-agent-after-session-ingest == 'true'/);
  assert.match(ordered.if, /needs\.deploy-session-ingest\.result == 'success'/);
  assert.equal(ordered.environment, '${{ inputs.target_environment }}');

  // The order is a job dependency, so no job holds a runner while it waits: no
  // step reads the run's jobs or sleeps.
  for (const [name, job] of Object.entries(workers.jobs)) {
    for (const step of job.steps) {
      assert.doesNotMatch(step.name ?? '', /Wait for session-ingest/, name);
      assert.doesNotMatch(step.run ?? '', /actions\/runs\/.*\/jobs|sleep \d/, name);
    }
  }

  const prepare = ordered.steps.findIndex(step => step.id === 'runtime');
  const deploy = ordered.steps.findIndex(step => step.name === 'Deploy cloud-agent-next');
  assert.ok(prepare >= 0 && prepare < deploy);

  assert.equal(ordered.steps[deploy].with.preCommands, 'pnpm run predeploy');
  assert.equal(ordered.steps[deploy + 1].with.preCommands, 'pnpm run predeploy');
});

test('the ordered production path takes both workers out of the parallel matrix', () => {
  const detect = workers.jobs['detect-changes'];
  const script = detect.steps.find(step => step.id === 'set-matrix').run;
  const start = script.indexOf('FILTERED=()');
  const reassignment = 'CHANGED=("${FILTERED[@]}")';
  const end = script.indexOf(reassignment);
  assert.ok(start >= 0 && end > start, 'the matrix filter must exist');
  const loop = script.slice(start, end + reassignment.length);

  const filter = (changed, ordered) =>
    execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        [
          `DEPLOY_CLOUD_AGENT_AFTER_SESSION_INGEST=${ordered}`,
          `CHANGED=(${changed.map(dir => `'${dir}'`).join(' ')})`,
          loop,
          'printf "%s\\n" "${CHANGED[@]}"',
        ].join('\n'),
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean);

  assert.deepEqual(filter(['services/session-ingest', 'services/cloud-agent-next'], 'true'), []);
  assert.deepEqual(
    filter(['services/session-ingest', 'services/cloud-agent-next', 'services/scim-sync'], 'true'),
    ['services/scim-sync']
  );
  assert.deepEqual(
    filter(['services/session-ingest', 'services/cloud-agent-next'], 'false'),
    ['services/session-ingest', 'services/cloud-agent-next'],
    'every other deployment path keeps both workers in the matrix'
  );
});
