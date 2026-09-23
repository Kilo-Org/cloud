import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

function readRepositoryFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function readJob(name, file = 'deploy-workers.yml') {
  const workflow = load(readRepositoryFile(`.github/workflows/${file}`));
  assert.ok(workflow && typeof workflow === 'object' && 'jobs' in workflow);
  assert.ok(workflow.jobs && typeof workflow.jobs === 'object' && name in workflow.jobs);
  return workflow.jobs[name];
}

const contractDirectory = 'packages/session-ingest-contracts';
const contractName = JSON.parse(readRepositoryFile(`${contractDirectory}/package.json`)).name;
const agentDirectory = 'services/cloud-agent-next';
const ingestDirectory = 'services/session-ingest';
const tokenDirectory = 'services/git-token-service';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-workers-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  function write(path, content) {
    const destination = join(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }

  function workspace(path, name, dependencies = {}, staging = false) {
    write(`${path}/package.json`, JSON.stringify({ name, private: true, dependencies }));
    if (path.startsWith('services/')) {
      write(`${path}/wrangler.jsonc`, JSON.stringify({ env: staging ? { staging: {} } : {} }));
    }
  }

  const { packageManager } = JSON.parse(readRepositoryFile('package.json'));
  write('package.json', JSON.stringify({ name: 'worker-deployment-fixture', packageManager }));
  write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - services/*\n');
  workspace(contractDirectory, contractName);
  for (const path of [agentDirectory, ingestDirectory, tokenDirectory]) {
    const manifest = JSON.parse(readRepositoryFile(`${path}/package.json`));
    assert.equal(manifest.dependencies[contractName], 'workspace:*');
    workspace(path, manifest.name, { [contractName]: manifest.dependencies[contractName] }, true);
  }
  workspace('packages/client', '@fixture/client', { [contractName]: 'workspace:*' });
  workspace('services/transitive', '@fixture/transitive', { '@fixture/client': 'workspace:*' });
  workspace('services/unrelated', '@fixture/unrelated');
  workspace('services/kiloclaw', '@fixture/kiloclaw', { [contractName]: 'workspace:*' }, true);
  workspace('services/gastown', '@fixture/gastown', {}, true);
  workspace('services/wasteland', '@fixture/wasteland', {}, true);
  workspace('services/deploy-infra/builder', '@fixture/builder');
  workspace(
    'services/deploy-infra/builder-docker-container/container-files',
    '@fixture/template',
    {},
    true
  );
  workspace('services/unrelated/node_modules/ignored', '@fixture/ignored', {}, true);
  return directory;
}

function detect(directory, files, targetEnvironment = 'production', failure = '') {
  const step = readJob('detect-changes').steps.find(step => step.id === 'set-matrix');
  const outputPath = join(directory, 'github-output');
  const result = spawnSync(
    'bash',
    [
      '--noprofile',
      '--norc',
      '-euo',
      'pipefail',
      '-c',
      `
        git() {
          [[ "$TARGET_ENVIRONMENT" == production ]] || return 2
          [[ "$*" == "diff --name-only --no-renames $BASE_SHA HEAD" ]] || return 2
          [[ "$TEST_FAILURE" != git ]] || return 3
          printf '%s\\n' "$TEST_CHANGED_FILES"
        }
        if [[ "$TEST_FAILURE" == pnpm ]]; then
          pnpm() { return 4; }
        fi
        ${step.run}
      `,
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COREPACK_HOME: process.env.COREPACK_HOME,
        COREPACK_ENABLE_NETWORK: '0',
        npm_config_userconfig: '/dev/null',
        BASE_SHA: targetEnvironment === 'production' ? 'before-multi-commit-push' : '',
        TARGET_ENVIRONMENT: targetEnvironment,
        GITHUB_OUTPUT: outputPath,
        TEST_CHANGED_FILES: files.join('\n'),
        TEST_FAILURE: failure,
      },
    }
  );
  if (result.error) throw result.error;
  if (failure) {
    assert.notEqual(result.status, 0, result.stderr);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries(
    readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  return { matrix: JSON.parse(outputs.matrix), sessionIngestFirst: outputs.session_ingest_first };
}

test('contract-only changes select direct and transitive consumers and group ingest with agent', t => {
  const result = detect(fixture(t), [`${contractDirectory}/src/rpc-contract.ts`]);
  assert.deepEqual(result, {
    matrix: [agentDirectory, tokenDirectory, 'services/transitive'],
    sessionIngestFirst: 'true',
  });
});

test('mixed changes keep unrelated workers independent and do not deploy ingest twice', t => {
  const result = detect(fixture(t), [
    `${contractDirectory}/src/rpc-contract.ts`,
    `${ingestDirectory}/src/index.ts`,
    `${agentDirectory}/src/index.ts`,
    'services/unrelated/src/index.ts',
    'services/kiloclaw/src/index.ts',
  ]);
  assert.deepEqual(result, {
    matrix: [agentDirectory, tokenDirectory, 'services/transitive', 'services/unrelated'],
    sessionIngestFirst: 'true',
  });
});

for (const files of [
  [],
  ['packages/unrelated/src/index.ts'],
  ['packages/session-ingest-contracts-other/src/index.ts'],
  ['apps/web/src/index.ts'],
]) {
  test(`unrelated changes do not deploy workers: ${JSON.stringify(files)}`, t => {
    assert.deepEqual(detect(fixture(t), files), { matrix: [], sessionIngestFirst: 'false' });
  });
}

for (const worker of [agentDirectory, ingestDirectory, 'services/deploy-infra/builder']) {
  test(`direct changes still deploy only ${worker}`, t => {
    assert.deepEqual(detect(fixture(t), [`${worker}/src/index.ts`]), {
      matrix: [worker],
      sessionIngestFirst: 'false',
    });
  });
}

test('staging keeps named-environment selection without a base SHA or production prerequisite', t => {
  const result = detect(fixture(t), [`${contractDirectory}/src/rpc-contract.ts`], 'staging');
  assert.deepEqual(result, {
    matrix: [agentDirectory, tokenDirectory, ingestDirectory],
    sessionIngestFirst: 'false',
  });
});

test('an environment without configured workers emits an empty matrix', t => {
  assert.deepEqual(detect(fixture(t), [], 'preview'), {
    matrix: [],
    sessionIngestFirst: 'false',
  });
});

for (const failure of ['git', 'pnpm']) {
  test(`${failure} failure blocks detection instead of silently skipping contract consumers`, t => {
    detect(fixture(t), [`${contractDirectory}/src/rpc-contract.ts`], 'production', failure);
  });
}

test('detection sets up pnpm and Node, uses explicit inputs and exposes the prerequisite flag', () => {
  const job = readJob('detect-changes');
  const detectionIndex = job.steps.findIndex(step => step.id === 'set-matrix');
  for (const action of ['pnpm/action-setup@', 'actions/setup-node@']) {
    const setupIndex = job.steps.findIndex(step => step.uses?.startsWith(action));
    assert.ok(setupIndex >= 0 && setupIndex < detectionIndex);
  }
  assert.equal(job.steps[0].with['fetch-depth'], 0);
  assert.equal(job.steps[detectionIndex].shell, 'bash');
  assert.deepEqual(job.steps[detectionIndex].env, {
    BASE_SHA: '${{ inputs.base_sha }}',
    TARGET_ENVIRONMENT: '${{ inputs.target_environment }}',
  });
  assert.deepEqual(job.outputs, {
    matrix: '${{ steps.set-matrix.outputs.matrix }}',
    session_ingest_first: '${{ steps.set-matrix.outputs.session_ingest_first }}',
  });
});

test('workflow requires ingest success before agent deployment without serializing other matrix entries', () => {
  const job = readJob('deploy-changed');
  assert.equal(job.needs, 'detect-changes');
  assert.equal(job['continue-on-error'], undefined);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.strategy['max-parallel'], undefined);
  assert.equal(job.strategy.matrix.worker, '${{ fromJson(needs.detect-changes.outputs.matrix) }}');
  assert.equal(job.environment, '${{ inputs.target_environment }}');
  const steps = job.steps;
  const ingestIndex = steps.findIndex(step => step.with?.workingDirectory === ingestDirectory);
  const agentIndex = steps.findIndex(
    step => step.with?.workingDirectory === '${{ matrix.worker }}'
  );
  const installIndex = steps.findIndex(step => step.run === 'pnpm install --frozen-lockfile');
  assert.ok(installIndex >= 0 && installIndex < ingestIndex && ingestIndex < agentIndex);
  const ingest = steps[ingestIndex];
  const agent = steps[agentIndex];
  assert.equal(
    ingest.if,
    "matrix.worker == 'services/cloud-agent-next' && needs.detect-changes.outputs.session_ingest_first == 'true'"
  );
  assert.equal(ingest.uses, agent.uses);
  assert.ok(ingest.uses.startsWith('cloudflare/wrangler-action@'));
  assert.equal(ingest.with.command, 'deploy');
  assert.equal(ingest.with.apiToken, agent.with.apiToken);
  assert.equal(ingest.with.preCommands, agent.with.preCommands);
  assert.equal(ingest['continue-on-error'], undefined);
  assert.equal(agent['continue-on-error'], undefined);
  assert.equal(agent.if, undefined);
  assert.equal(
    agent.with.command,
    "${{ inputs.target_environment == 'production' && 'deploy' || format('deploy --env {0}', inputs.target_environment) }}"
  );
  const bun = steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'));
  assert.equal(bun.if, "matrix.worker == 'services/cloud-agent-next'");
  assert.ok(steps.indexOf(bun) < agentIndex);
});

test('manual worker deployment stays independent and staging callers keep their environment', () => {
  const manual = readJob('deploy-manual');
  assert.equal(manual.if, "inputs.worker != ''");
  assert.equal(manual.needs, undefined);
  assert.equal(manual.environment, '${{ inputs.target_environment }}');
  const deployments = manual.steps.filter(step =>
    step.uses?.startsWith('cloudflare/wrangler-action@')
  );
  assert.equal(deployments.length, 1);
  assert.equal(deployments[0].with.workingDirectory, '${{ inputs.worker }}');
  assert.equal(
    deployments[0].with.command,
    "${{ inputs.target_environment == 'production' && 'deploy' || format('deploy --env {0}', inputs.target_environment) }}"
  );
  assert.equal(
    readJob('detect-changes').if,
    "inputs.worker == '' && (inputs.base_sha != '' || inputs.target_environment != 'production')"
  );
  const production = readJob('deploy-workers', 'deploy-production.yml');
  const staging = readJob('deploy-workers', 'deploy-staging.yml');
  assert.equal(production.uses, './.github/workflows/deploy-workers.yml');
  assert.deepEqual(production.with, {
    base_sha: '${{ needs.resolve-worker-base.outputs.base_sha }}',
  });
  assert.equal(staging.uses, './.github/workflows/deploy-workers.yml');
  assert.deepEqual(staging.with, { target_environment: 'staging' });
});

test('CI runs deployment regressions before change filtering', () => {
  const job = readJob('changes', 'ci.yml');
  const index = job.steps.findIndex(
    step => step.run === 'node --test scripts/deploy-workers.test.mjs'
  );
  assert.equal(job.if, undefined);
  assert.equal(job['continue-on-error'], undefined);
  assert.ok(index > job.steps.findIndex(step => step.run?.includes('install --frozen-lockfile')));
  assert.ok(index < job.steps.findIndex(step => step.id === 'filter'));
  assert.equal(job.steps[index].if, undefined);
  assert.equal(job.steps[index]['continue-on-error'], undefined);
});
