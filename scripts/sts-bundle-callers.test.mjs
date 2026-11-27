// Holds every job that reads an STS bundle with .github/actions/sts-bundle to the
// rules in that action's README: its STS policy names its workflow file, its
// environment and its events; it installs nothing; every step before the read is
// trusted; each value reaches a step's `env:` (or an action's input) and never a
// command line; the migrated GitHub secrets have no reader left; and the reusable
// workflows that read a bundle keep exactly their reviewed callers.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { load } from 'js-yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const POLICIES = new URL('../services/sts/policy/', import.meta.url);
const ACTION = './.github/actions/sts-bundle';
const MAIN = 'refs/heads/main';

const workflows = Object.fromEntries(
  readdirSync(WORKFLOWS)
    .filter(file => /\.ya?ml$/.test(file))
    .map(file => [file, load(readFileSync(new URL(file, WORKFLOWS), 'utf8'))])
);

const policyUrl = workload => new URL(`${workload}.yaml`, POLICIES);
const policy = workload => load(readFileSync(policyUrl(workload), 'utf8'));

// Each reader job, the workloads it can read (one per GitHub environment it can
// run in), and the GitHub environment of each. `policyElsewhere`: the policy
// lands with its own change; its checks run once the file is in this tree.
const READERS = [
  {
    file: 'cloud-agent-e2e.yml',
    job: 'tests',
    workloads: { 'cloud-agent-e2e': 'ci-cloud-agent-e2e' },
    policyElsewhere: true,
  },
  {
    file: 'stage-vercel-deployment.yml',
    job: 'stage',
    workloads: { production: 'ci-vercel-stage', staging: 'ci-vercel-stage-staging' },
  },
  {
    file: 'promote-vercel-deployment.yml',
    job: 'promote',
    workloads: { production: 'ci-vercel-promote' },
  },
  {
    file: 'cloud-agent-sentry-sourcemaps.yml',
    job: 'upload',
    workloads: { production: 'ci-cloud-agent-sentry', staging: 'ci-cloud-agent-sentry-staging' },
  },
  { file: 'kilo-app-release.yml', job: 'preflight', workloads: { release: 'ci-kilo-app-release' } },
  {
    file: 'kilo-app-release.yml',
    job: 'build-and-submit',
    workloads: { release: 'ci-kilo-app-release' },
  },
  { file: 'auto-docs.yml', job: 'call-valtown', workloads: { production: 'ci-auto-docs' } },
  {
    file: 'push-dev-kiloclaw.yml',
    job: 'push-dev',
    workloads: { '': 'ci-kiloclaw-dev-push' },
  },
];

// The GitHub secrets these bundles replace: no workflow may read them any more.
const MIGRATED = [
  'VERCEL_TOKEN_APP',
  'VERCEL_TOKEN_AI_GATEWAY',
  'VERCEL_TOKEN_AI_GATEWAY_SECURE_PROXY',
  'VERCEL_TOKEN',
  'AXIOM_ANNOTATION_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'EXPO_TOKEN',
  'DOC_WEBHOOK_URL',
  'DOC_WEBHOOK_SECRET',
  'FLY_DEV_API_TOKEN',
];

// Reusable workflows whose jobs read a bundle: any workflow on main that calls
// one in a policy's environment receives that bundle, so the callers are pinned.
const REUSABLE_CALLERS = {
  'stage-vercel-deployment.yml': [
    'deploy-ai-gateway-secure-proxy.yml#stage-secure-proxy',
    'deploy-production.yml#stage-ai-gateway',
    'deploy-production.yml#stage-app',
    'deploy-staging.yml#deploy-ai-gateway',
    'deploy-staging.yml#deploy-app',
    'redeploy-web.yml#stage-app',
  ],
  'promote-vercel-deployment.yml': [
    'deploy-ai-gateway-secure-proxy.yml#promote-secure-proxy',
    'deploy-production.yml#promote-ai-gateway',
    'deploy-production.yml#promote-app',
    'redeploy-web.yml#promote-app',
  ],
  'cloud-agent-sentry-sourcemaps.yml': ['deploy-workers.yml#upload-cloud-agent-sentry'],
};

const PACKAGE_MANAGER = /(^|[\s;&|(`'"])(pnpm|npm|npx|yarn|bun|bunx|pip|uv)(\s|$)/m;
const INSTALLER_ACTIONS = /^(pnpm\/action-setup|oven-sh\/setup-bun|actions\/cache)@/;
// Actions a step before the read may use: they only fetch this repository or
// put Node on the runner, each pinned by commit.
const TRUSTED_BEFORE_READ =
  /^(useblacksmith\/checkout|actions\/checkout|actions\/setup-node)@[0-9a-f]{40}$/;

const isRead = step => step.uses === ACTION;
const environmentName = job =>
  typeof job.environment === 'object' ? job.environment?.name : job.environment;

function readerJobs() {
  const found = [];
  for (const [file, document] of Object.entries(workflows)) {
    for (const [name, job] of Object.entries(document.jobs ?? {})) {
      if ((job.steps ?? []).some(isRead)) found.push(`${file}#${name}`);
    }
  }
  return found.sort();
}

test('every job that reads a bundle is listed here', () => {
  assert.deepEqual(readerJobs(), READERS.map(reader => `${reader.file}#${reader.job}`).sort());
});

for (const reader of READERS) {
  const job = workflows[reader.file].jobs[reader.job];
  const label = `${reader.file}#${reader.job}`;
  const steps = job.steps;
  const reads = steps.filter(isRead);
  const firstRead = steps.findIndex(isRead);

  test(`${label}: has id-token, its environment and a policy that names it`, () => {
    assert.equal(job.permissions?.['id-token'], 'write');
    const environment = environmentName(job) ?? '';
    const environments = Object.keys(reader.workloads);
    if (environments.length === 1) {
      assert.equal(environment, environments[0], 'the job runs in its policy environment');
    } else {
      assert.equal(environment, '${{ inputs.target_environment }}');
    }
    const events = Object.keys(workflows[reader.file].on ?? {});
    for (const [githubEnvironment, workload] of Object.entries(reader.workloads)) {
      if (reader.policyElsewhere && !existsSync(policyUrl(workload))) continue;
      const document = policy(workload);
      assert.equal(document.workload, workload);
      assert.equal(document.identity.repository, 'Kilo-Org/cloud');
      assert.equal(document.identity.repositoryId, '1145038391');
      assert.equal(document.identity.repositoryOwnerId, '201822503');
      assert.deepEqual(document.identity.jobWorkflowRefs, [
        `Kilo-Org/cloud/.github/workflows/${reader.file}@${MAIN}`,
      ]);
      assert.deepEqual(document.identity.refs ?? [MAIN], [MAIN]);
      assert.equal(document.identity.environment ?? '', githubEnvironment);
      // A called workflow inherits its callers' events; a top-level one lists its own.
      if (!events.includes('workflow_call')) {
        assert.deepEqual(
          [...document.identity.events].sort(),
          events.filter(event => event !== 'pull_request').sort(),
          `${workload} accepts exactly the events of ${reader.file}`
        );
      }
    }
    const workflowEnv = { ...workflows[reader.file].env, ...job.env };
    for (const read of reads) {
      const named = String(read.with.workload).replace(
        /^\$\{\{ env\.([A-Z_]+) \}\}$/,
        (_, name) => workflowEnv[name]
      );
      const workloads = Object.values(reader.workloads);
      if (named.startsWith('${{')) {
        for (const workload of workloads) {
          assert.ok(named.includes(workload.replace(/-staging$/, '')), `${label} reads ${named}`);
        }
      } else {
        assert.ok(workloads.includes(named), `${label} reads ${named}`);
      }
    }
  });

  test(`${label}: installs nothing and runs no package manager`, () => {
    for (const step of steps) {
      assert.doesNotMatch(
        step.uses ?? '',
        INSTALLER_ACTIONS,
        `${label}: ${step.name ?? step.uses}`
      );
      assert.doesNotMatch(step.run ?? '', PACKAGE_MANAGER, `${label}: ${step.name}`);
      assert.equal(step.with?.cache, undefined, `${label}: ${step.name} restores no package cache`);
    }
  });

  test(`${label}: every step before the first read is trusted`, () => {
    assert.ok(firstRead >= 0);
    for (const step of steps.slice(0, firstRead)) {
      if (step.uses) {
        assert.match(step.uses, TRUSTED_BEFORE_READ, `${label}: ${step.uses} runs before the read`);
      } else {
        assert.doesNotMatch(step.run, /download-artifact|tar\s+-x|GITHUB_PATH|GITHUB_ENV/);
      }
    }
    // Downloads and unpacked tools come after every read.
    const lastRead = steps.findLastIndex(isRead);
    for (const step of steps.slice(0, lastRead)) {
      assert.doesNotMatch(step.uses ?? '', /download-artifact/, `${label}: download before a read`);
    }
  });

  test(`${label}: bundle values reach only a step's env or an action input`, () => {
    const ids = reads.map(read => read.id);
    assert.ok(ids.every(Boolean), 'every read has an id');
    const pattern = new RegExp(`steps\\.(${ids.join('|')})\\.outputs`);
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), pattern, 'no job-level env');
    assert.doesNotMatch(JSON.stringify(job.outputs ?? {}), pattern, 'no job output');
    for (const step of steps) {
      assert.doesNotMatch(step.run ?? '', pattern, `${label}: ${step.name} interpolates a value`);
      assert.doesNotMatch(step.if ?? '', pattern, `${label}: ${step.name} tests a value in if`);
    }
  });
}

test('the migrated GitHub secrets have no reader in any workflow or action', () => {
  const texts = [
    ...Object.keys(workflows).map(file => readFileSync(new URL(file, WORKFLOWS), 'utf8')),
    readFileSync(new URL('../.github/actions/sts-bundle/action.yml', import.meta.url), 'utf8'),
  ];
  for (const name of MIGRATED) {
    const reader = new RegExp(`secrets\\.${name}\\b|secrets\\[['"]${name}['"]\\]`);
    for (const text of texts) assert.doesNotMatch(text, reader, name);
  }
});

test('each reusable workflow that reads a bundle keeps exactly its reviewed callers', () => {
  for (const [file, expected] of Object.entries(REUSABLE_CALLERS)) {
    const callers = [];
    for (const [caller, document] of Object.entries(workflows)) {
      for (const [name, job] of Object.entries(document.jobs ?? {})) {
        if (job.uses === `./.github/workflows/${file}`) {
          callers.push(`${caller}#${name}`);
          assert.equal(job.secrets, undefined, `${caller}#${name} passes no secret`);
          assert.equal(job.permissions?.['id-token'], 'write', `${caller}#${name} grants id-token`);
        }
      }
    }
    assert.deepEqual(callers.sort(), [...expected].sort(), file);
    assert.deepEqual(Object.keys(workflows[file].on), ['workflow_call'], `${file} is only called`);
    // Only the reader job holds id-token; a helper job installs with none.
    for (const [name, job] of Object.entries(workflows[file].jobs)) {
      const reads = (job.steps ?? []).some(isRead);
      assert.equal(job.permissions?.['id-token'], reads ? 'write' : undefined, `${file}#${name}`);
    }
  }
});

test('each stage caller requests a project token its environment policy holds', () => {
  for (const caller of REUSABLE_CALLERS['stage-vercel-deployment.yml']) {
    const [file, name] = caller.split('#');
    const job = workflows[file].jobs[name];
    const environment = job.with.target_environment;
    const workload =
      environment === 'production' ? 'ci-vercel-stage' : `ci-vercel-stage-${environment}`;
    assert.ok(policy(workload).secrets.includes(job.with.vercel_token_key), caller);
  }
});

test('every bundle key a reader requests is an output of the action and a secret of its policy', () => {
  const action = load(
    readFileSync(new URL('../.github/actions/sts-bundle/action.yml', import.meta.url), 'utf8')
  );
  const outputs = Object.keys(action.outputs);
  for (const reader of READERS) {
    const policies = Object.values(reader.workloads).filter(workload =>
      existsSync(policyUrl(workload))
    );
    assert.ok(reader.policyElsewhere || policies.length > 0, `${reader.file} has its policy here`);
    const held = new Set(policies.flatMap(workload => policy(workload).secrets));
    for (const read of workflows[reader.file].jobs[reader.job].steps.filter(isRead)) {
      const keys = String(read.with.secrets)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
      for (const key of keys) {
        if (key.startsWith('${{')) continue; // the stage job's key comes from its caller
        assert.ok(outputs.includes(key), `${key} is an output of the action`);
        if (policies.length > 0) {
          assert.ok(held.has(key), `${key} is a secret of ${reader.file}#${reader.job}'s policy`);
        }
      }
    }
  }
});

test('the failure notices and the STS watch keep their Slack webhook outside STS', () => {
  // Criterion 2 exception (manager ruling M112b): these alerts must still post when STS is down.
  const readers = Object.entries(workflows)
    .filter(([file]) =>
      readFileSync(new URL(file, WORKFLOWS), 'utf8').includes(
        'secrets.DEPLOY_NOTIFY_SLACK_WEBHOOK_URL'
      )
    )
    .map(([file]) => file)
    .sort();
  assert.deepEqual(readers, [
    'notify-main-failure.yml',
    'notify-production-deploy-failure.yml',
    'sts-deployment-watch-health.yml',
    'sts-deployment-watch.yml',
  ]);
});
