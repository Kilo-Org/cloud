import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
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

test('Cloud Agent source-map uploads are best-effort without masking build or deploy failures', () => {
  for (const [job, selector] of [
    ['deploy-manual', 'inputs.worker'],
    ['deploy-changed', 'matrix.worker'],
    ['deploy-cloud-agent-after-session-ingest', undefined],
  ]) {
    const steps = workers.jobs[job].steps;
    const deploy = steps.find(step => step.id === (selector ? 'deploy' : 'deploy-cloud-agent'));
    const retry = steps.find(step => step.name?.endsWith('(retry)'));
    const maps = steps.find(step => step.name === 'Upload Cloud Agent Sentry source maps');
    assert.equal(maps['continue-on-error'], true);
    assert.equal(maps.if, selector ? `${selector} == 'services/cloud-agent-next'` : undefined);
    assert.doesNotMatch(maps.if ?? '', /always\(|failure\(/);
    assert.ok(steps.indexOf(maps) > steps.indexOf(retry));
    assert.equal(maps.run, 'pnpm run sentry:sourcemaps');
    assert.equal(maps.env.SENTRY_AUTH_TOKEN, '${{ secrets.SENTRY_AUTH_TOKEN }}');
    assert.equal(retry.if, `steps.${deploy.id}.outcome == 'failure'`);
    assert.equal(retry['continue-on-error'], undefined);
    assert.equal(deploy['continue-on-error'], true);
    assert.equal(workers.jobs[job]['continue-on-error'], undefined);
    assert.equal(retry.with.command, deploy.with.command);
    for (const upload of [deploy, retry]) {
      assert.equal(upload.env.CLOUD_AGENT_DEPLOY_ENVIRONMENT, '${{ inputs.target_environment }}');
      assert.equal(
        upload.with.preCommands.trim(),
        'if [ "$(jq -r \'.scripts.predeploy // empty\' package.json)" != "" ]; then pnpm run predeploy; fi'
      );
    }
  }
});

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
      `\${{ ${selector} == 'services/cloud-agent-next' && format('{0} dist/worker/index.js --no-bundle --upload-source-maps', steps.runtime.outputs.command || (inputs.target_environment == 'production' && 'deploy' || format('deploy --env {0}', inputs.target_environment))) || (steps.runtime.outputs.command || (inputs.target_environment == 'production' && 'deploy' || format('deploy --env {0}', inputs.target_environment))) }} ` +
        "${{ steps.usage_queues.outputs.queues_required == 'true' && '--experimental-provision=false' || '' }}"
    );
  }
});

test('both upload attempts preserve prepared commands and append artifacts only for Cloud Agent', () => {
  for (const job of [
    'deploy-manual',
    'deploy-changed',
    'deploy-cloud-agent-after-session-ingest',
  ]) {
    const uploads = workers.jobs[job].steps.filter(step =>
      step.uses?.startsWith('cloudflare/wrangler-action@')
    );
    assert.equal(uploads.length, 2);
    for (const step of uploads) {
      const expression = step.with.command.match(/^\$\{\{ (.*?) \}\}/)[1];
      const selectedWorkers =
        job === 'deploy-cloud-agent-after-session-ingest'
          ? ['services/cloud-agent-next']
          : ['services/cloud-agent-next', 'services/usage-ingest', 'services/other-worker'];
      for (const worker of selectedWorkers) {
        for (const environment of ['production', 'staging']) {
          for (const prepared of [undefined, 'deploy --config prepared.jsonc']) {
            const actual = runInNewContext(expression, {
              inputs: { worker, target_environment: environment },
              matrix: { worker },
              steps: { runtime: { outputs: { command: prepared } } },
              format: (template, ...values) =>
                template.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]),
            });
            const command =
              prepared || (environment === 'production' ? 'deploy' : 'deploy --env staging');
            assert.equal(
              actual,
              worker === 'services/cloud-agent-next'
                ? `${command} dist/worker/index.js --no-bundle --upload-source-maps`
                : command
            );
          }
        }
      }
    }
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
  const predicate = check.run.replace(/\\\n\s*/g, ' ');
  assert.ok(
    predicate.includes('git diff --quiet "$base_sha" "$target_sha" -- .'),
    'the deploy predicate must diff the whole tree'
  );
  for (const excluded of [
    'apps/mobile',
    'apps/extension',
    'apps/storybook',
    '.github',
    'dev',
    'tools',
    'scripts',
    'script',
    'docs',
    '.specs',
    '.agents',
    '.kilo',
    '.kfab',
    '.vscode',
    '.cursor',
    '.husky',
    '.plans',
    '(glob)*.md',
  ]) {
    assert.ok(
      predicate.includes(
        `':(exclude${excluded === '(glob)*.md' ? ',glob' : ''})${excluded === '(glob)*.md' ? '*.md' : excluded}'`
      ),
      `the deploy predicate must exclude ${excluded}`
    );
  }
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

test('ai-gateway deploys with each scheduled release and its promotion waits for the gate', () => {
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
  assert.equal(deployAiGateway.needs, 'check-changes');
  assert.equal(deployAiGateway.with.target_environment, 'staging');
  assert.equal(deployAiGateway.with.vercel_project_id_var, 'VERCEL_PROJECT_ID_AI_GATEWAY');
  assert.equal(deployAiGateway.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
  assert.equal(
    deployAiGateway.secrets.VERCEL_PROJECT_TOKEN,
    '${{ secrets.VERCEL_TOKEN_AI_GATEWAY }}'
  );

  // Neither pipeline's Workers read anything the Vercel deploys produce, so both
  // start with the gate and the matrix lookup rather than with those deploys.
  // record-deployment below still requires the Vercel legs and the Worker deploy.
  for (const [name, deployment] of [
    ['production', production],
    ['staging', staging],
  ]) {
    assert.deepEqual(
      [...deployment.jobs['deploy-workers'].needs].sort(),
      ['check-changes', 'db-gate', 'detect-workers'],
      `${name} Worker deploy waits only for its own inputs`
    );
    assert.doesNotMatch(
      deployment.jobs['deploy-workers'].if,
      /needs\.(stage-app|stage-ai-gateway|promote-app|promote-ai-gateway|deploy-app|deploy-ai-gateway)\.result/
    );
  }

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

test('one database gate per deployment runs the migration proxy script and holds no database credential', () => {
  for (const [name, deployment, environment, proxyUrl, timeout] of [
    ['production', production, 'production', 'https://migration-proxy.kiloapps.io', 45],
    ['staging', staging, 'staging', 'https://migration-proxy-staging.kiloapps.io', 15],
  ]) {
    const job = deployment.jobs['db-gate'];
    assert.equal(job.environment, environment);
    assert.equal(job['timeout-minutes'], timeout);
    assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
    assert.equal(job.env, undefined, `${name} db-gate must hold no job-level env`);
    for (const secret of ['POSTGRES_URL', 'DATABASE_CA']) {
      assert.doesNotMatch(
        JSON.stringify(deployment),
        new RegExp(`secrets\\.${secret}\\b`),
        `${name} must not read the ${secret} secret`
      );
    }

    // Two steps: the checkout that brings the script, and the script.
    assert.equal(job.steps.length, 2);
    const [checkout, run] = job.steps;
    assert.match(checkout.uses, /^useblacksmith\/checkout@[0-9a-f]{40}$/);
    assert.deepEqual(checkout.with, {
      ref: '${{ needs.check-changes.outputs.target_sha }}',
      'persist-credentials': false,
    });
    // It builds nothing, so it must not pay for the LFS objects only the web build reads.
    assert.equal(checkout.with.lfs, undefined, `${name} db-gate checkout must skip LFS`);
    assert.equal(run.run, 'bash scripts/migration-proxy-run.sh');
    assert.deepEqual(run.env, {
      MIGRATION_PROXY_URL: proxyUrl,
      MIGRATION_PROXY_AUDIENCE: proxyUrl,
      TARGET_SHA: '${{ needs.check-changes.outputs.target_sha }}',
    });

    // The job installs, probes and migrates nothing itself.
    const text = JSON.stringify(job);
    for (const removed of [
      /pnpm/,
      /setup-node/,
      /drizzle/,
      /check-production-db-startup/,
      /POSTGRES_URL/,
      /DATABASE_CA/,
    ]) {
      assert.doesNotMatch(text, removed, `${name} db-gate must not contain ${removed}`);
    }

    // The gate reads nothing from the triggering run: no payload, no artifact, no input.
    assert.doesNotMatch(text, /github\.event\.workflow_run/);
    assert.doesNotMatch(text, /actions\/download-artifact/);
    assert.doesNotMatch(text, /inputs\./);
  }

  const wrangler = readFileSync(
    new URL('../services/migration-proxy/wrangler.jsonc', import.meta.url),
    'utf8'
  );
  for (const host of ['migration-proxy.kiloapps.io', 'migration-proxy-staging.kiloapps.io']) {
    assert.ok(
      wrangler.includes(`"pattern": "${host}"`),
      `the proxy Worker must serve ${host}, the URL db-gate calls`
    );
  }

  assert.equal(
    existsSync(new URL('./check-production-db-startup.ts', import.meta.url)),
    false,
    'the proxy probes the database; the CI probe script is gone'
  );

  // Counterweight to the skipped LFS above: the web build itself keeps its
  // objects, because next.config.mjs fails on the kilo-anim pointer file.
  const buildCheckout = ci.jobs['build'].steps.find(step =>
    step.uses?.startsWith('useblacksmith/checkout@')
  );
  assert.equal(buildCheckout.with.lfs, true, 'the web build checkout must keep LFS');

  for (const [deployment, jobs] of [
    [production, ['promote-app', 'promote-ai-gateway', 'deploy-workers', 'record-deployment']],
    [staging, ['deploy-workers', 'record-deployment']],
  ]) {
    for (const job of jobs) {
      assert.ok(deployment.jobs[job].needs.includes('db-gate'), `${job} must wait for db-gate`);
    }
  }
  // The staging Vercel deploys start with the SHA lookup and reach the staging
  // target on their own: a custom environment cannot hold the traffic switch
  // until the gate finishes, so they run beside it. The Worker deploy and the
  // release record below keep the gate, so a failed migration still stops them.
  for (const job of ['deploy-app', 'deploy-ai-gateway']) {
    assert.equal(staging.jobs[job].needs, 'check-changes', `${job} must start beside db-gate`);
  }
  // Production names the gate result explicitly so a skipped gate cannot let the
  // Worker deploy run ahead of the migrations; staging relies on the default
  // needs-success behaviour for the same gate.
  for (const job of ['deploy-workers', 'record-deployment']) {
    assert.match(production.jobs[job].if, /needs\.db-gate\.result == 'success'/);
  }
  assert.match(staging.jobs['record-deployment'].if, /needs\.db-gate\.result == 'success'/);
});

test('only db-gate may mint a GitHub OIDC token in either deploy workflow', () => {
  for (const [name, deployment] of [
    ['production', production],
    ['staging', staging],
  ]) {
    assert.equal(deployment.permissions['id-token'], undefined, `${name} workflow-level block`);
    const minting = Object.entries(deployment.jobs)
      .filter(([, job]) => job.permissions?.['id-token'] !== undefined)
      .map(([id, job]) => [id, job.permissions['id-token']]);
    assert.deepEqual(minting, [['db-gate', 'write']], `${name} jobs with id-token`);
  }
});

// The db-gate script against a mocked proxy and a mocked runner token endpoint. Every token is a
// sentinel, and every mocked body carries fields outside RunView and the status bodies; none of
// them may reach the output.
const MIGRATION_SCRIPT = fileURLToPath(new URL('./migration-proxy-run.sh', import.meta.url));
const OIDC_SENTINEL = 'OIDC-TOKEN-SENTINEL';
const REQUEST_SENTINEL = 'RUNNER-REQUEST-TOKEN-SENTINEL';
const LEAK = 'LEAK-NOT-A-RUNVIEW-FIELD';
const PROXY_AUDIENCE = 'https://migration-proxy-staging.kiloapps.io';
const TARGET = '0123456789abcdef0123456789abcdef01234567';
const RUN_A = '11111111-1111-4111-8111-111111111111';
const RUN_B = '22222222-2222-4222-9222-222222222222';
const RUN_C = '33333333-3333-4333-a333-333333333333';

function runView(id, state, extra = {}) {
  const final = state === 'succeeded' || state === 'failed';
  return {
    id,
    environment: 'staging',
    state,
    phase: final ? 'done' : state === 'running' ? 'migrating' : 'fetching',
    sha: TARGET,
    attestedSha: TARGET,
    github: { runId: '123', runAttempt: '1', eventName: 'workflow_run' },
    createdAt: '2026-11-27T10:00:00.000Z',
    startedAt: state === 'pending' ? null : '2026-11-27T10:00:20.000Z',
    finishedAt: final ? '2026-11-27T10:01:00.000Z' : null,
    heartbeatAt: null,
    pending: state === 'succeeded' ? [] : ['0390_new_table'],
    applied:
      state === 'succeeded'
        ? [{ tag: '0390_new_table', hash: 'a'.repeat(64), createdAt: 1769695991111 }]
        : [],
    failure: null,
    pollAfterSeconds: 20,
    message: LEAK,
    ...extra,
  };
}

function failedView(id, failure) {
  return runView(id, 'failed', {
    failure: { sqlstate: null, migrationTag: null, message: LEAK, detail: LEAK, ...failure },
  });
}

async function runMigrationScript({ posts, gets = {}, env = {} }) {
  const issued = [];
  const requests = [];
  const problems = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const reply = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (url.pathname === '/oidc') {
        if (request.headers.authorization !== `bearer ${REQUEST_SENTINEL}`) {
          problems.push('runner token request without the request token');
        }
        if (url.searchParams.get('audience') !== PROXY_AUDIENCE) {
          problems.push(`audience ${url.searchParams.get('audience')}`);
        }
        const token = `${OIDC_SENTINEL}-${issued.length}`;
        issued.push(token);
        return reply(200, { count: issued.length, value: token });
      }
      // A fresh token for every proxy request: the newest issued one, used once.
      const expected = `Bearer ${issued.at(-1)}`;
      if (request.headers.authorization !== expected || issued.length !== requests.length + 1) {
        problems.push(`${request.method} ${url.pathname} without a fresh token`);
      }
      requests.push({ method: request.method, path: url.pathname, body });
      const queue = request.method === 'POST' ? posts : gets[url.pathname.split('/').at(-1)];
      const next = queue?.shift();
      if (next === undefined) {
        problems.push(`unexpected ${request.method} ${url.pathname}`);
        return reply(599, {});
      }
      return reply(next.status, next.body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'migration-proxy-run-'));
  try {
    // A sleep that records its argument and returns at once.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const sleepLog = join(dir, 'sleeps');
    writeFileSync(sleepLog, '');
    writeFileSync(join(bin, 'sleep'), `#!/bin/sh\necho "$1" >> '${sleepLog}'\n`, { mode: 0o755 });
    const child = spawn('bash', [MIGRATION_SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        MIGRATION_PROXY_URL: base,
        MIGRATION_PROXY_AUDIENCE: PROXY_AUDIENCE,
        TARGET_SHA: TARGET,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_SENTINEL,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const code = await new Promise(resolve => child.on('close', resolve));
    const sleeps = readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean);

    assert.deepEqual(problems, [], output);
    for (const secret of [OIDC_SENTINEL, REQUEST_SENTINEL, LEAK]) {
      assert.ok(!output.includes(secret), `the output must not carry ${secret}:\n${output}`);
    }
    assert.doesNotMatch(output, /authorization|bearer/i);
    assert.doesNotMatch(output, /^::(?!error::)/m, 'no workflow command but ::error');
    for (const post of requests.filter(request => request.method === 'POST')) {
      assert.equal(post.body, JSON.stringify({ sha: TARGET }));
    }
    return { code, output, requests, sleeps };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const accepted = view => ({ status: 202, body: { status: 'accepted', run: view } });
const postCount = requests => requests.filter(request => request.method === 'POST').length;

test('the db-gate script polls an accepted run to success and prints only RunView fields', async () => {
  const { code, output, requests, sleeps } = await runMigrationScript({
    posts: [accepted(runView(RUN_A, 'pending'))],
    gets: {
      [RUN_A]: [
        { status: 200, body: runView(RUN_A, 'running') },
        { status: 200, body: runView(RUN_A, 'succeeded') },
      ],
    },
  });
  assert.equal(code, 0, output);
  assert.equal(postCount(requests), 1);
  assert.deepEqual(
    requests.filter(request => request.method === 'GET').map(request => request.path),
    [`/v1/runs/${RUN_A}`, `/v1/runs/${RUN_A}`]
  );
  assert.deepEqual(sleeps, ['20', '20']);
  assert.match(output, /running\/migrating/);
  assert.match(output, new RegExp(`applied 0390_new_table ${'a'.repeat(64)} 1769695991111`));
});

test('the db-gate script re-POSTs once after a retryable failure, never twice', async () => {
  const retryable = id =>
    failedView(id, { code: 'probe_failed', reason: 'connect_timeout', retryable: true });

  const recovered = await runMigrationScript({
    posts: [accepted(runView(RUN_A, 'pending')), accepted(runView(RUN_B, 'pending'))],
    gets: {
      [RUN_A]: [{ status: 200, body: retryable(RUN_A) }],
      [RUN_B]: [{ status: 200, body: runView(RUN_B, 'succeeded') }],
    },
  });
  assert.equal(recovered.code, 0, recovered.output);
  assert.equal(postCount(recovered.requests), 2);
  assert.match(recovered.output, /code=probe_failed retryable=true reason=connect_timeout/);

  const exhausted = await runMigrationScript({
    posts: [accepted(runView(RUN_A, 'pending')), accepted(runView(RUN_B, 'pending'))],
    gets: {
      [RUN_A]: [{ status: 200, body: retryable(RUN_A) }],
      [RUN_B]: [{ status: 200, body: retryable(RUN_B) }],
    },
  });
  assert.equal(exhausted.code, 1, exhausted.output);
  assert.equal(postCount(exhausted.requests), 2);
  assert.match(exhausted.output, /::error::migration run failed: probe_failed/);
});

test('the db-gate script fails at once on a non-retryable failure and prints its fields', async () => {
  const migrationFailed = await runMigrationScript({
    posts: [accepted(runView(RUN_A, 'pending'))],
    gets: {
      [RUN_A]: [
        {
          status: 200,
          body: failedView(RUN_A, {
            code: 'migration_failed',
            retryable: false,
            sqlstate: '42P01',
            // A hostile value cannot start its own log line or workflow command.
            migrationTag: '0390_new_table\n::add-mask::x',
          }),
        },
      ],
    },
  });
  assert.equal(migrationFailed.code, 1, migrationFailed.output);
  assert.equal(postCount(migrationFailed.requests), 1);
  assert.match(
    migrationFailed.output,
    /failure code=migration_failed retryable=false sqlstate=42P01 migrationTag=0390_new_table\?::add-mask::x/
  );

  const existing = await runMigrationScript({
    posts: [
      {
        status: 200,
        body: {
          status: 'existing',
          run: failedView(RUN_A, {
            code: 'invalid_index_present',
            retryable: false,
            indexes: ['idx_broken'],
          }),
        },
      },
    ],
  });
  assert.equal(existing.code, 1, existing.output);
  assert.equal(existing.requests.length, 1);
  assert.match(existing.output, /invalid index idx_broken/);

  const unapproved = await runMigrationScript({
    posts: [
      {
        status: 200,
        body: {
          status: 'existing',
          run: failedView(RUN_A, {
            code: 'migration_not_approved',
            retryable: false,
            files: [
              {
                path: 'packages/db/src/migrations/0390_new_table.sql',
                reason: 'author_only',
                pr: 42,
              },
            ],
          }),
        },
      },
    ],
  });
  assert.equal(unapproved.code, 1, unapproved.output);
  assert.match(
    unapproved.output,
    /file packages\/db\/src\/migrations\/0390_new_table\.sql reason=author_only pr=42/
  );
});

test('the db-gate script waits out busy, limited and unavailable answers without a new run', async () => {
  const { code, output, requests, sleeps } = await runMigrationScript({
    posts: [
      {
        status: 409,
        body: { status: 'busy', activeRunId: RUN_C, retryAfterSeconds: 5, detail: LEAK },
      },
      { status: 429, body: { status: 'limited', reason: 'rate_limited', retryAfterSeconds: 120 } },
      {
        status: 503,
        body: { status: 'unavailable', reason: 'sts_unavailable', retryAfterSeconds: 15 },
      },
      { status: 200, body: { status: 'already_applied', run: runView(RUN_A, 'succeeded') } },
    ],
    gets: { [RUN_C]: [{ status: 200, body: runView(RUN_C, 'running') }] },
  });
  assert.equal(code, 0, output);
  assert.equal(postCount(requests), 4);
  // busy waits at least 30 s, then shows the active run before the next POST.
  assert.deepEqual(sleeps, ['30', '120', '15']);
  assert.deepEqual(
    requests.map(request => `${request.method} ${request.path}`),
    ['POST /v1/runs', `GET /v1/runs/${RUN_C}`, 'POST /v1/runs', 'POST /v1/runs', 'POST /v1/runs']
  );
  assert.match(output, new RegExp(`run ${RUN_C} staging: running/migrating`));
  assert.match(output, /migration proxy: already_applied/);
});

test('the db-gate script fails at once on a refusal and prints only its documented fields', async () => {
  const attempted = 'f'.repeat(40);
  for (const [status, body, expected] of [
    [
      403,
      { status: 'denied', reason: 'sha_behind_attempted', attemptedSha: attempted, detail: LEAK },
      new RegExp(`HTTP 403 status=denied reason=sha_behind_attempted attemptedSha=${attempted}`),
    ],
    [
      403,
      { status: 'denied', reason: 'sha_diverged', attemptedSha: attempted },
      /Never deploy the older commit by hand/,
    ],
    [
      401,
      { status: 'denied', reason: 'identity_rejected' },
      /HTTP 401 status=denied reason=identity_rejected/,
    ],
    [400, { status: 'invalid_request' }, /HTTP 400 status=invalid_request/],
    [500, { status: 'config_invalid' }, /HTTP 500 status=config_invalid/],
    [502, `<html>${LEAK}</html>`, /HTTP 502 $/m],
  ]) {
    const run = await runMigrationScript({ posts: [{ status, body }] });
    assert.equal(run.code, 1, run.output);
    assert.equal(run.requests.length, 1, `${status} must not be re-POSTed`);
    assert.match(run.output, expected);
  }

  const invalid = await runMigrationScript({ posts: [], env: { TARGET_SHA: 'main' } });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.requests.length, 0);
  assert.match(invalid.output, /TARGET_SHA must be 40 lowercase hex characters/);
});

test('every Worker deploy job retries a failed dependency install at most three times', () => {
  // A registry download that fails on the runner leaves a lifecycle script (the
  // workerd postinstall) failed, and a plain rerun repeats that script. A flake
  // then passes on a later attempt, while a real failure still ends the job.
  const dir = mkdtempSync(join(tmpdir(), 'install-retry-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/usr/bin/env bash\nprintf x >> "$CALLS"\n[ "$(wc -c < "$CALLS")" -gt "$FAILURES" ]\n',
      { mode: 0o755 }
    );
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\necho "$1" >> "$SLEEPS"\n', {
      mode: 0o755,
    });
    const installRuns = [];
    for (const job of [
      'deploy-manual',
      'deploy-changed',
      'deploy-session-ingest',
      'deploy-cloud-agent-after-session-ingest',
      'deploy-uts',
      'deploy-uts-feed-after-uts',
    ]) {
      installRuns.push(
        ...workers.jobs[job].steps.filter(step => (step.run ?? '').includes('pnpm install'))
      );
    }
    assert.equal(installRuns.length, 6);

    for (const { run } of installRuns) {
      for (const [failures, status, calls, sleeps] of [
        [0, 0, 1, ''],
        [2, 0, 3, '20\n40\n'],
        [3, 1, 3, '20\n40\n'],
      ]) {
        const callsFile = join(dir, 'calls');
        const sleepsFile = join(dir, 'sleeps');
        writeFileSync(callsFile, '');
        writeFileSync(sleepsFile, '');
        const result = spawnSync('bash', ['-e', '-c', run], {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CALLS: callsFile,
            SLEEPS: sleepsFile,
            FAILURES: String(failures),
          },
        });
        assert.equal(result.status, status, `${failures} failures: ${result.stderr}`);
        assert.equal(readFileSync(callsFile, 'utf8').length, calls, `${failures} failures`);
        assert.equal(readFileSync(sleepsFile, 'utf8'), sleeps, `${failures} failures`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    ['deploy-uts', 'services/uts'],
    ['deploy-uts-feed-after-uts', 'services/uts-feed'],
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
  for (const [deployment, environment] of [
    [production, 'production'],
    [staging, 'staging'],
  ]) {
    const job = deployment.jobs['detect-workers'];
    assert.equal(job.with.base_sha, '${{ needs.check-changes.outputs.base_sha }}');
    assert.equal(job.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
    if (environment === 'staging') {
      assert.equal(job.with.target_environment, 'staging');
    }
  }
  assert.equal(staging.jobs['deploy-workers'].with.target_environment, 'staging');
  assert.equal(
    staging.jobs['deploy-workers'].with.source_sha,
    '${{ needs.check-changes.outputs.target_sha }}'
  );
  // Detection runs in the call that carries the baseline and no matrix, so a
  // deploy call never repeats the diff work.
  assert.match(workers.jobs['detect-changes'].if, /inputs\.base_sha != ''/);
  assert.match(workers.jobs['detect-changes'].if, /inputs\.worker_matrix == ''/);
  const detect = workers.jobs['detect-changes'].steps.find(step => step.id === 'set-matrix');
  assert.match(detect.run, /has_named_environment "\$dir\/wrangler\.jsonc"/);
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

test('a manual nonproduction deploy requires the named Worker environment before any deploy work', () => {
  // Without its own env.<target> object Wrangler warns and deploys the top-level
  // production configuration, so the manual path stops before installing,
  // publishing a runtime, provisioning or calling Wrangler.
  const steps = workers.jobs['deploy-manual'].steps;
  const index = steps.findIndex(step => step.name === 'Require the named Worker environment');
  const preflight = steps[index];
  assert.equal(steps[index - 1].name, 'Setup Node.js');
  assert.equal(preflight.if, "inputs.target_environment != 'production'");
  assert.deepEqual(preflight.env, {
    WORKER: '${{ inputs.worker }}',
    TARGET_ENVIRONMENT: '${{ inputs.target_environment }}',
  });
  assert.ok(!preflight.run.includes('${{'), 'inputs reach the shell only through env');
  for (const earlier of steps.slice(0, index)) {
    assert.ok(!(earlier.run ?? '').includes('pnpm'), earlier.name);
    assert.ok(!(earlier.uses ?? '').startsWith('cloudflare/'), earlier.name);
  }
  // The matrix skip reads the same checker rather than a second parser.
  const detect = workers.jobs['detect-changes'].steps.find(step => step.id === 'set-matrix');
  assert.ok(
    detect.run.includes('node scripts/has-named-environment.mjs "$1" "$TARGET_ENVIRONMENT"')
  );
  assert.ok(!detect.run.includes('stripJsonComments'));

  const dir = mkdtempSync(join(tmpdir(), 'named-environment-'));
  try {
    symlinkSync(fileURLToPath(new URL('.', import.meta.url)), join(dir, 'scripts'));
    const write = (worker, contents) => {
      mkdirSync(join(dir, worker), { recursive: true });
      writeFileSync(join(dir, worker, 'wrangler.jsonc'), contents);
    };
    // Comment-looking text, escaped quotes and `,}` inside strings stay literal.
    write(
      'services/genuine',
      '{\n  // top level is production\n  "name": "w", /* note */\n  "env": { "staging": {\n    "name": "w-staging",\n    "route": "https://x.example/* not a comment */ // nor this",\n    "quoted": "a\\\\\\"b,}",\n  }, },\n}\n'
    );
    write('services/absent', '{ "name": "w", "env": { "production": {} } }');
    write('services/no-env', '{ "name": "w", "vars": { "env": { "staging": {} } } }');
    write('services/not-object', '{ "name": "w", "env": { "staging": true } }');
    write('services/malformed', '{ "name": "w", "env": { "staging": { ');
    write('services/unterminated', '{ "env": { "staging": {} } /* never closed ');
    write('services/merged', '{ "env": { "staging": {} }, "port": 80/**/80 }');
    write('services/empty-comma', '{ "env": { "staging": {} }, "routes": [,] }');
    mkdirSync(join(dir, 'services/missing'), { recursive: true });

    const run = (worker, environment = 'staging') =>
      spawnSync('bash', ['-e', '-c', preflight.run], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, WORKER: worker, TARGET_ENVIRONMENT: environment },
      });
    const admitted = run('services/genuine');
    assert.equal(admitted.status, 0, admitted.stderr);
    for (const worker of [
      'services/absent',
      'services/no-env',
      'services/not-object',
      'services/malformed',
      'services/missing',
      'services/unterminated',
      'services/merged',
      'services/empty-comma',
    ]) {
      const result = run(worker);
      assert.equal(result.status, 1, worker);
      assert.match(result.stderr, /refusing to deploy/, worker);
      assert.doesNotMatch(result.stderr, /Unexpected|ENOENT|"env"/, worker);
    }
    assert.equal(run('services/genuine', '').status, 1, 'an empty target fails closed');
    assert.equal(run('services/genuine', 'constructor').status, 1, 'only own keys count');
    assert.equal(run('services/genuine', '$(exit 0)').status, 1, 'the target is not evaluated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Worker detection and deploy run beside the Vercel chain in both pipelines', () => {
  // Detection reads only the SHAs check-changes publishes, and the deploy call
  // reads only the detected matrix, so neither waits for a Vercel deploy or a
  // promotion before it starts. record-deployment still gates the release on
  // every leg.
  for (const [name, deployment, chainDependencies] of [
    [
      'production',
      production,
      ['stage-app', 'stage-ai-gateway', 'promote-app', 'promote-ai-gateway'],
    ],
    ['staging', staging, []],
  ]) {
    const job = deployment.jobs['detect-workers'];
    assert.equal(job.needs, 'check-changes', `${name} detection starts from the lookup`);
    assert.equal(job.uses, './.github/workflows/deploy-workers.yml');
    assert.match(job.if, /should_deploy == 'true'/);
    // The detection call names a baseline and no matrix, so it cannot deploy.
    assert.equal(job.with.base_sha, '${{ needs.check-changes.outputs.base_sha }}');
    assert.equal(job.with.worker_matrix, undefined);
    for (const dependency of chainDependencies) {
      assert.equal(
        [job.needs].flat().includes(dependency),
        false,
        `${name} detection must not wait for ${dependency}`
      );
      // The Worker deploy consumes only the detected matrix and the SHAs, so it
      // starts beside those deploys rather than after them; record-deployment
      // still gates the release on every one of them.
      assert.equal(
        [deployment.jobs['deploy-workers'].needs].flat().includes(dependency),
        false,
        `${name} Worker deploy must not wait for ${dependency}`
      );
      assert.ok(
        deployment.jobs['record-deployment'].needs.includes(dependency),
        `${name} release record still waits for ${dependency}`
      );
    }
    const deploy = deployment.jobs['deploy-workers'];
    assert.ok([deploy.needs].flat().includes('detect-workers'), `${name} deploy needs the matrix`);
    assert.equal(deploy.with.worker_matrix, '${{ needs.detect-workers.outputs.matrix }}');
    assert.equal(
      deploy.with.deploy_cloud_agent_after_session_ingest,
      '${{ needs.detect-workers.outputs.deploy-cloud-agent-after-session-ingest }}'
    );
    assert.equal(
      deploy.with.deploy_uts_feed_after_uts,
      '${{ needs.detect-workers.outputs.deploy-uts-feed-after-uts }}'
    );
    assert.equal(deploy.with.source_sha, '${{ needs.check-changes.outputs.target_sha }}');
    assert.equal(deploy.with.base_sha, undefined, `${name} deploy call must not run detection`);
  }
  for (const dependency of ['db-gate', 'detect-workers']) {
    assert.ok([staging.jobs['deploy-workers'].needs].flat().includes(dependency));
  }

  // A failed or skipped detection skips the called workflow instead of running it
  // with an empty matrix, which would deploy nothing and report success. The
  // database gate keeps its own explicit result check: a skipped gate must not
  // let Workers deploy ahead of the migrations.
  const deploy = production.jobs['deploy-workers'];
  const condition = deploy.if
    .replace(/^\$\{\{|\}\}$/g, '')
    .replace(/needs\.([\w-]+)\.outputs/g, 'needs["$1"].outputs')
    .replace(/needs\.([\w-]+)\.result/g, 'needs["$1"].result');
  const deployRuns = results => {
    const needs = Object.fromEntries(
      deploy.needs.map(name => [
        name,
        {
          result: results[name] ?? 'success',
          outputs: { should_deploy: results.should_deploy ?? 'true' },
        },
      ])
    );
    return runInNewContext(condition, {
      needs,
      github: { repository: 'Kilo-Org/cloud' },
      cancelled: () => false,
    });
  };
  assert.equal(deployRuns({}), true, 'a healthy run deploys the detected workers');
  for (const dependency of deploy.needs.filter(name => name !== 'check-changes')) {
    assert.equal(
      deployRuns({ [dependency]: 'failure' }),
      false,
      `a failed ${dependency} must block the Worker deploy`
    );
  }
  for (const dependency of ['db-gate', 'detect-workers']) {
    assert.equal(
      deployRuns({ [dependency]: 'skipped' }),
      false,
      `a skipped ${dependency} must block the Worker deploy`
    );
  }
  // A failed lookup skips detection, and a skipped detection skips the deploy.
  assert.equal(deployRuns({ 'check-changes': 'failure', 'detect-workers': 'skipped' }), false);
  assert.equal(deployRuns({ should_deploy: 'false' }), false);

  // The detection call publishes the matrix, and the deploy call reads it from
  // its inputs, so the deploy jobs never wait for a job in their own run.
  assert.equal(
    workers.on.workflow_call.outputs.matrix.value,
    '${{ jobs.detect-changes.outputs.matrix }}'
  );
  assert.equal(
    workers.on.workflow_call.outputs['deploy-cloud-agent-after-session-ingest'].value,
    '${{ jobs.detect-changes.outputs.deploy-cloud-agent-after-session-ingest }}'
  );
  assert.equal(
    workers.on.workflow_call.outputs['deploy-uts-feed-after-uts'].value,
    '${{ jobs.detect-changes.outputs.deploy-uts-feed-after-uts }}'
  );
  const changed = workers.jobs['deploy-changed'];
  assert.equal(changed.needs, undefined);
  assert.equal(changed.strategy.matrix.worker, '${{ fromJson(inputs.worker_matrix) }}');
  assert.match(changed.if, /inputs\.worker_matrix != '\[\]'/);
  assert.match(changed.if, /inputs\.worker_matrix != ''/);
  const missing = workers.jobs['missing-selection'];
  assert.equal(
    missing.if,
    "inputs.worker == '' && inputs.worker_matrix == '' && inputs.base_sha == ''"
  );
  assert.match(missing.steps[0].run, /exit 1/);
  assert.equal(
    workers.on.workflow_call.inputs.worker_matrix.default,
    '',
    'a deploy call must supply the matrix explicitly'
  );
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

    // Docs-only, CI-only and scripts-only commits touch no deploy input, so
    // each skips the release the way a mobile-only commit already did. The
    // exclusion list lives in the check-deployment-changes.yml predicate.
    mkdirSync(join(directory, 'docs'), { recursive: true });
    writeFileSync(join(directory, 'docs', 'note.md'), 'docs');
    commit('docs');
    assert.equal(runGate(deployedSha).should_deploy, 'false');

    mkdirSync(join(directory, '.github'), { recursive: true });
    writeFileSync(join(directory, '.github', 'workflows-ci.yml'), 'ci');
    commit('ci');
    assert.equal(runGate(deployedSha).should_deploy, 'false');

    mkdirSync(join(directory, 'scripts'), { recursive: true });
    writeFileSync(join(directory, 'scripts', 'tool.sh'), 'scripts');
    commit('scripts');
    assert.equal(runGate(deployedSha).should_deploy, 'false');

    // A markdown file inside apps/web is a deploy input: the web app compiles
    // page.md and page.mdx under its app directory into routes
    // (pageExtensions in apps/web/next.config.mjs), so only root-level
    // markdown is excluded.
    mkdirSync(join(directory, 'apps/web/src/app'), { recursive: true });
    writeFileSync(join(directory, 'apps/web/src/app', 'page.md'), 'route');
    commit('web route');
    assert.equal(runGate(deployedSha).should_deploy, 'true');

    // Root build inputs stay deploy-triggering.
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'kilocode-monorepo', private: true })
    );
    commit('root package');
    assert.equal(runGate(deployedSha).should_deploy, 'true');

    writeFileSync(join(directory, 'apps/web/file'), 'web');
    commit('web');
    assert.deepEqual(runGate(deployedSha), {
      base_sha: deployedSha,
      target_sha: git('rev-parse', 'HEAD'),
      should_deploy: 'true',
    });
    assert.match(
      readFileSync(join(directory, '.git', 'test-summary'), 'utf8'),
      /Deploying candidate/
    );

    writeFileSync(join(directory, 'services/kiloclaw/file'), 'worker');
    commit('worker');
    mkdirSync(join(directory, 'packages/kiloclaw-secret-catalog'), { recursive: true });
    writeFileSync(join(directory, 'packages/kiloclaw-secret-catalog/file'), 'shared package');
    commit('shared package');
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
    ['deploy-uts', 'Deploy uts', 'deploy'],
    ['deploy-uts-feed-after-uts', 'Deploy uts-feed', 'deploy'],
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
  // The deploy call reads the flag from the detection call's output.
  assert.equal(
    workers.on.workflow_call.outputs['deploy-cloud-agent-after-session-ingest'].value,
    '${{ jobs.detect-changes.outputs.deploy-cloud-agent-after-session-ingest }}'
  );
  assert.equal(
    workers.on.workflow_call.outputs.matrix.value,
    '${{ jobs.detect-changes.outputs.matrix }}'
  );

  const ingest = workers.jobs['deploy-session-ingest'];
  assert.equal(ingest.needs, undefined);
  assert.equal(
    ingest.if,
    "github.repository == 'Kilo-Org/cloud' && inputs.deploy_cloud_agent_after_session_ingest == 'true'"
  );
  assert.equal(ingest.environment, '${{ inputs.target_environment }}');
  assert.equal(ingest['timeout-minutes'], 25);

  const ordered = workers.jobs['deploy-cloud-agent-after-session-ingest'];
  assert.deepEqual([ordered.needs].flat(), ['deploy-session-ingest']);
  assert.match(ordered.if, /deploy_cloud_agent_after_session_ingest == 'true'/);
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

  // A source SHA may not define `predeploy`; an unguarded call fails the deploy.
  const guardedPredeploy =
    'if [ "$(jq -r \'.scripts.predeploy // empty\' package.json)" != "" ]; then pnpm run predeploy; fi\n';
  assert.equal(ordered.steps[deploy].with.preCommands, guardedPredeploy);
  assert.equal(ordered.steps[deploy + 1].with.preCommands, guardedPredeploy);
});

test('the ordered production path takes both workers out of the parallel matrix', () => {
  const detect = workers.jobs['detect-changes'];
  const script = detect.steps.find(step => step.id === 'set-matrix').run;
  const start = script.indexOf('FILTERED=()');
  const reassignment = 'CHANGED=("${FILTERED[@]}")';
  const end = script.indexOf(reassignment);
  assert.ok(start >= 0 && end > start, 'the matrix filter must exist');
  const loop = script.slice(start, end + reassignment.length);

  const filter = (changed, ordered, utsOrdered = 'false') =>
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
          `DEPLOY_UTS_FEED_AFTER_UTS=${utsOrdered}`,
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
  assert.deepEqual(
    filter(['services/uts', 'services/uts-feed', 'services/scim-sync'], 'false', 'true'),
    ['services/scim-sync'],
    'the ordered UTS path owns both UTS workers'
  );
  assert.deepEqual(filter(['services/uts-feed'], 'false', 'false'), ['services/uts-feed']);
});

test('the UTS feed Worker deploys after the UTS mint Worker job when both change', () => {
  const detect = workers.jobs['detect-changes'];
  assert.equal(
    detect.outputs['deploy-uts-feed-after-uts'],
    '${{ steps.set-matrix.outputs.deploy-uts-feed-after-uts }}'
  );
  assert.equal(workers.on.workflow_call.inputs.deploy_uts_feed_after_uts.default, 'false');

  // The flag is set only when both UTS Workers are among the changed workers.
  const script = detect.steps.find(step => step.id === 'set-matrix').run;
  const start = script.indexOf('DEPLOY_UTS_FEED_AFTER_UTS=false');
  const end = script.indexOf('echo "deploy-uts-feed-after-uts=');
  assert.ok(start >= 0 && end > start, 'the UTS order decision must exist');
  const decide = changed =>
    execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        [
          `CHANGED=(${changed.map(dir => `'${dir}'`).join(' ')})`,
          script.slice(start, end),
          'echo "$DEPLOY_UTS_FEED_AFTER_UTS"',
        ].join('\n'),
      ],
      { encoding: 'utf8' }
    ).trim();
  assert.equal(decide(['services/uts', 'services/uts-feed']), 'true');
  assert.equal(decide(['services/scim-sync', 'services/uts-feed', 'services/uts']), 'true');
  assert.equal(decide(['services/uts']), 'false');
  assert.equal(decide(['services/uts-feed']), 'false');
  assert.equal(decide(['services/uts-feedback', 'services/uts']), 'false');
  assert.equal(decide([]), 'false');

  const mint = workers.jobs['deploy-uts'];
  assert.equal(mint.needs, undefined);
  assert.equal(
    mint.if,
    "github.repository == 'Kilo-Org/cloud' && inputs.deploy_uts_feed_after_uts == 'true'"
  );
  assert.equal(mint.environment, '${{ inputs.target_environment }}');

  const feed = workers.jobs['deploy-uts-feed-after-uts'];
  assert.deepEqual([feed.needs].flat(), ['deploy-uts']);
  assert.match(feed.if, /deploy_uts_feed_after_uts == 'true'/);
  assert.match(feed.if, /needs\.deploy-uts\.result == 'success'/);
  assert.equal(feed.environment, '${{ inputs.target_environment }}');

  for (const [job, dir] of [
    [mint, 'services/uts'],
    [feed, 'services/uts-feed'],
  ]) {
    const deploys = job.steps.filter(step => step.uses?.startsWith('cloudflare/wrangler-action@'));
    assert.equal(deploys.length, 2);
    for (const step of deploys) {
      assert.equal(step.with.workingDirectory, dir);
      assert.equal(
        step.with.command,
        "${{ inputs.target_environment == 'production' && 'deploy' || format('deploy --env {0}', inputs.target_environment) }}"
      );
    }
  }
});

test('a Pages pin move deploys the output shell beside Pages', t => {
  const detect = workers.jobs['detect-changes'];
  const script = detect.steps.find(step => step.id === 'set-matrix').run;
  const start = script.indexOf('CHANGED=()');
  const end = script.indexOf('DEPLOY_CLOUD_AGENT_AFTER_SESSION_INGEST=false');
  assert.ok(start >= 0 && end > start, 'the change loop must exist');
  const loop = script.slice(start, end);

  const directory = mkdtempSync(join(tmpdir(), 'pages-pin-detection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  const commit = (files, message) => {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(join(directory, file, '..'), { recursive: true });
      writeFileSync(join(directory, file), contents);
    }
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const base = commit(
    {
      'services/pages/source.json': '{"tag":"pages-000000000000"}',
      'services/pages/README.md': 'Pages',
      'services/pages-output/wrangler.jsonc': '{}',
    },
    'base'
  );

  // Detection on `branch` against `base`. `narrow` stands for the workspace
  // rule: what scripts/affected-workspaces.mjs selected. Without it the broad
  // rule runs, as when that detection is unavailable.
  const detected = (branch, narrow) => {
    git('checkout', '-q', branch);
    return execFileSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-eo',
        'pipefail',
        '-c',
        [
          'TARGET_ENVIRONMENT=production',
          `BASE_SHA=${base}`,
          'DEPLOYABLE=(services/pages services/pages-output)',
          `NARROW=${narrow === undefined ? 'false' : 'true'}`,
          'WORKSPACE_DIRS=$(printf "%s\\n" services/pages services/pages-output)',
          `AFFECTED_DIRS=$(printf "%s\\n" ${(narrow ?? []).join(' ')})`,
          'has_named_environment() { return 1; }',
          loop,
          'printf "%s\\n" "${CHANGED[@]}"',
        ].join('\n'),
      ],
      { cwd: directory, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean);
  };

  git('checkout', '-q', '-b', 'pin', base);
  commit({ 'services/pages/source.json': '{"tag":"pages-111111111111"}' }, 'pin');
  const both = ['services/pages', 'services/pages-output'];
  // The source.json rule selects the shell whatever the workspace rule says.
  assert.deepEqual(
    detected('pin'),
    both,
    'a pin move deploys the shell when workspace detection is unavailable'
  );
  assert.deepEqual(
    detected('pin', ['services/pages']),
    both,
    'a pin move deploys the shell when the workspace rule selected only Pages'
  );

  // A change to the shared archive code reaches the shell through the
  // workspace rule alone: the shell's build imports ../pages/scripts/, so
  // affected-workspaces.mjs selects it as a reader of services/pages.
  git('checkout', '-q', '-b', 'loader', base);
  commit({ 'services/pages/scripts/pinned.mjs': 'export {};' }, 'loader');
  assert.deepEqual(detected('loader', both), both, 'the workspace rule selects the reader');
  assert.deepEqual(detected('loader', ['services/pages']), ['services/pages']);

  git('checkout', '-q', '-b', 'docs', base);
  commit({ 'services/pages/README.md': 'Pages, again' }, 'docs');
  assert.deepEqual(detected('docs'), ['services/pages'], 'another Pages change leaves the shell');
});

test('Vercel deployment steps pass the deployment URL as one argument', () => {
  // The promote step reads the caller URL from its env. The stage step accepts
  // the single https line that `vercel deploy` prints and writes it as the
  // deployment_url output. Both steps run here under bash -e with a stub
  // vercel, so the assertions read the arguments the CLI receives and the
  // output the stage step writes.
  const VERCEL_STUB = [
    '#!/usr/bin/env bash',
    'for argument in "$@"; do',
    '  printf \'%s\\n\' "$argument" >> "$ARGV_LOG"',
    'done',
    'if [ "$1" = deploy ]; then',
    '  printf \'%s\\n\' "$DEPLOY_OUTPUT"',
    'fi',
    'exit 0',
    '',
  ].join('\n');

  // Reads one step of a loaded workflow by its name.
  const namedStep = (document, name) => {
    const steps = Object.values(document.jobs).flatMap(job => job.steps ?? []);
    const step = steps.find(candidate => candidate.name === name);
    assert.ok(step, `the workflow must define a step named ${name}`);
    return { env: step.env ?? {}, run: step.run };
  };

  // Applies the runner expression substitution with the supplied values.
  const substituteExpressions = (text, values) =>
    text.replace(/\$\{\{\s*([^{}]*?)\s*\}\}/g, (_, expression) => {
      assert.ok(expression in values, `the test supplies no value for ${expression}`);
      return values[expression];
    });

  // Runs a step the way the runner does: bash -e, a stub vercel first on PATH,
  // the substituted env, and a temporary GITHUB_OUTPUT.
  const runStep = ({ document, name, values, deployOutput }) => {
    const step = namedStep(document, name);
    const directory = mkdtempSync(join(tmpdir(), 'vercel-step-'));
    try {
      const bin = join(directory, 'bin');
      const runnerTemp = join(directory, 'runner-temp');
      const argvLog = join(directory, 'argv');
      const githubOutput = join(directory, 'github-output');
      mkdirSync(bin);
      mkdirSync(runnerTemp);
      writeFileSync(argvLog, '');
      writeFileSync(githubOutput, '');
      writeFileSync(join(bin, 'vercel'), VERCEL_STUB, { mode: 0o755 });
      const substitutions = {
        'runner.temp': runnerTemp,
        'steps.vercel-cli-cache.outputs.cache-hit': 'false',
        ...values,
      };
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ARGV_LOG: argvLog,
        DEPLOY_OUTPUT: deployOutput ?? '',
        GITHUB_OUTPUT: githubOutput,
        RUNNER_TEMP: runnerTemp,
      };
      for (const [key, value] of Object.entries(step.env)) {
        env[key] = substituteExpressions(value, substitutions);
      }
      const result = spawnSync(
        'bash',
        ['-e', '-c', substituteExpressions(step.run, substitutions)],
        {
          cwd: directory,
          encoding: 'utf8',
          env,
        }
      );
      return {
        status: result.status,
        stderr: result.stderr,
        argv: readFileSync(argvLog, 'utf8').split('\n').filter(Boolean),
        output: readFileSync(githubOutput, 'utf8'),
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  const markerExists = path => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  };

  const markerDirectory = mkdtempSync(join(tmpdir(), 'vercel-marker-'));
  try {
    const marker = join(markerDirectory, 'marker');

    const promote = workflow('promote-vercel-deployment');
    const probeUrl = `https://probe.vercel.app"; touch ${marker}; echo "`;
    const promoted = runStep({
      document: promote,
      name: 'Promote Vercel deployment',
      values: {
        'inputs.deployment_url': probeUrl,
        'secrets.VERCEL_TOKEN': 'probe-token',
      },
    });
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(markerExists(marker), false, 'the step passes the URL verbatim');
    const promoteIndex = promoted.argv.indexOf('promote');
    assert.ok(promoteIndex >= 0, `the stub must run promote: ${promoted.argv.join(' | ')}`);
    assert.equal(
      promoted.argv[promoteIndex + 1],
      probeUrl,
      'the deployment URL arrives as one argv element'
    );
    assert.ok(
      promoted.argv.includes('--token=probe-token'),
      'the token arrives as its own argv element'
    );
    assert.ok(promoted.argv.includes('--scope=kilocode'), 'the scope stays on the command');

    const stage = workflow('stage-vercel-deployment');
    const stageValues = { 'secrets.VERCEL_PROJECT_TOKEN': 'probe-token' };

    const staged = runStep({
      document: stage,
      name: 'Stage Vercel deployment',
      values: stageValues,
      deployOutput: 'Vercel CLI 59.5.0\nhttps://probe-deployment.vercel.app',
    });
    assert.equal(staged.status, 0, staged.stderr);
    assert.equal(staged.output, 'deployment_url=https://probe-deployment.vercel.app\n');

    const rejected = runStep({
      document: stage,
      name: 'Stage Vercel deployment',
      values: stageValues,
      deployOutput: `https://probe.vercel.app; touch ${marker}`,
    });
    assert.notEqual(rejected.status, 0, 'the stage step accepts only a single https host');
    assert.equal(
      markerExists(marker),
      false,
      'the stage step runs the URL as one command argument'
    );
    assert.doesNotMatch(rejected.output, /deployment_url/);
    assert.match(rejected.stderr, /did not print a deployment URL/);

    const substituted = runStep({
      document: stage,
      name: 'Stage Vercel deployment',
      values: stageValues,
      deployOutput: 'https://probe.vercel.app$(id)',
    });
    assert.notEqual(substituted.status, 0, 'the stage step accepts only a single https host');
    assert.equal(substituted.output, '');
  } finally {
    rmSync(markerDirectory, { recursive: true, force: true });
  }
});
