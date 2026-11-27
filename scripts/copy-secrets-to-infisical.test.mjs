// Holds the one-shot copy workflow (.github/workflows/copy-secrets-to-infisical.yml) to its
// reviewed shape and its row table to the STS CI policies that read the copied values. Delete this
// file with the workflow.
//
// The policies arrive with the CI bundle change, which merges after this workflow has run, so on
// main the policy files are absent. POLICY_SNAPSHOT is the reviewed copy of their workloads,
// environments and secret names. The rows must equal the snapshot, and every snapshot policy
// present in the policy directory must equal it, so the comparison runs for real wherever the
// policy files exist: on the bundle change's branch once it contains this file, or on demand
// against any tree:
//
//   git archive <ref> services/sts/policy | tar -x -C /tmp/policy-check
//   COPY_POLICY_DIR=/tmp/policy-check/services/sts/policy node --test scripts/copy-secrets-to-infisical.test.mjs
//
// With COPY_POLICY_DIR set, every snapshot policy must be present.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

const WORKFLOW = new URL('../.github/workflows/copy-secrets-to-infisical.yml', import.meta.url);
const POLICY_DIR =
  process.env.COPY_POLICY_DIR || fileURLToPath(new URL('../services/sts/policy/', import.meta.url));
const REQUIRE_POLICIES = Boolean(process.env.COPY_POLICY_DIR);

const workflowText = readFileSync(WORKFLOW, 'utf8');
const workflow = load(workflowText);

// <GitHub secret> <Infisical environment> <Infisical path> <Infisical name>: the reviewed copy list.
const COPY_LIST = [
  'VERCEL_TOKEN_APP production /ci/ci-vercel-stage-production-app VERCEL_TOKEN_APP',
  'VERCEL_TOKEN_AI_GATEWAY production /ci/ci-vercel-stage-production-ai-gateway VERCEL_TOKEN_AI_GATEWAY',
  'VERCEL_TOKEN_AI_GATEWAY_SECURE_PROXY production /ci/ci-vercel-stage-production-ai-gateway-secure-proxy VERCEL_TOKEN_AI_GATEWAY_SECURE_PROXY',
  'VERCEL_TOKEN_APP production /ci/ci-vercel-stage-staging-app VERCEL_TOKEN_APP',
  'VERCEL_TOKEN_AI_GATEWAY production /ci/ci-vercel-stage-staging-ai-gateway VERCEL_TOKEN_AI_GATEWAY',
  'VERCEL_TOKEN production /ci/ci-vercel-promote VERCEL_TOKEN',
  'AXIOM_ANNOTATION_TOKEN production /ci/ci-vercel-promote AXIOM_ANNOTATION_TOKEN',
  'SENTRY_AUTH_TOKEN production /ci/ci-cloud-agent-sentry SENTRY_AUTH_TOKEN',
  'SENTRY_AUTH_TOKEN production /ci/ci-cloud-agent-sentry-staging SENTRY_AUTH_TOKEN',
  'EXPO_TOKEN production /ci/ci-kilo-app-release EXPO_TOKEN',
  'DOC_WEBHOOK_URL production /ci/ci-auto-docs DOC_WEBHOOK_URL',
  'DOC_WEBHOOK_SECRET production /ci/ci-auto-docs DOC_WEBHOOK_SECRET',
  'FLY_DEV_API_TOKEN staging /ci/ci-kiloclaw-dev-push FLY_DEV_API_TOKEN',
];

// The cloud CI policies that read these values: workload -> the manager environments it reads and
// its secret names. A policy reads the folder /ci/<workload> in each of its environments.
const POLICY_SNAPSHOT = {
  'ci-vercel-stage-production-app': { environments: ['production'], secrets: ['VERCEL_TOKEN_APP'] },
  'ci-vercel-stage-production-ai-gateway': {
    environments: ['production'],
    secrets: ['VERCEL_TOKEN_AI_GATEWAY'],
  },
  'ci-vercel-stage-production-ai-gateway-secure-proxy': {
    environments: ['production'],
    secrets: ['VERCEL_TOKEN_AI_GATEWAY_SECURE_PROXY'],
  },
  'ci-vercel-stage-staging-app': { environments: ['production'], secrets: ['VERCEL_TOKEN_APP'] },
  'ci-vercel-stage-staging-ai-gateway': {
    environments: ['production'],
    secrets: ['VERCEL_TOKEN_AI_GATEWAY'],
  },
  'ci-vercel-promote': {
    environments: ['production'],
    secrets: ['VERCEL_TOKEN', 'AXIOM_ANNOTATION_TOKEN'],
  },
  'ci-cloud-agent-sentry': { environments: ['production'], secrets: ['SENTRY_AUTH_TOKEN'] },
  'ci-cloud-agent-sentry-staging': { environments: ['production'], secrets: ['SENTRY_AUTH_TOKEN'] },
  'ci-kilo-app-release': { environments: ['production'], secrets: ['EXPO_TOKEN'] },
  'ci-auto-docs': {
    environments: ['production'],
    secrets: ['DOC_WEBHOOK_URL', 'DOC_WEBHOOK_SECRET'],
  },
  'ci-kiloclaw-dev-push': { environments: ['staging'], secrets: ['FLY_DEV_API_TOKEN'] },
};

const AUDIENCE = 'urn:kilo:cloud:copy-secrets-to-infisical';
const GATE =
  "github.repository == 'Kilo-Org/cloud' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' && github.triggering_actor == 'iscekic'";

const copyStep = workflow.jobs.copy.steps[0];
const probeStep = workflow.jobs['probe-login'].steps[0];

// The rows of ALL_ROWS in the copy step, each with the GitHub secret its variable is bound to.
function workflowRows() {
  const table = copyStep.run.match(/readonly ALL_ROWS=\(\n([\s\S]*?)\n\s*\)\n/);
  assert.ok(table, 'the copy step declares ALL_ROWS');
  return table[1]
    .split('\n')
    .map(line => line.trim())
    .map(line => {
      const row = line.match(
        /^"(V_[A-Z0-9_]+) (production|staging) (\/ci\/[a-z0-9-]+) ([A-Z0-9_]+)"$/
      );
      assert.ok(row, `row has the shape "<var> <environment> <path> <name>": ${line}`);
      const [, variable, environment, path, name] = row;
      const binding = copyStep.env[variable];
      assert.ok(binding, `${variable} is bound in the copy step's env`);
      const secret = binding.match(/^\$\{\{ secrets\.([A-Z0-9_]+) \}\}$/);
      assert.ok(secret, `${variable} is bound to exactly one secret`);
      assert.equal(variable, `V_${secret[1]}`, `${variable} is named after its secret`);
      return `${secret[1]} ${environment} ${path} ${name}`;
    });
}

function snapshotRows() {
  return Object.entries(POLICY_SNAPSHOT).flatMap(([workload, { environments, secrets }]) =>
    environments.flatMap(environment => secrets.map(secret => ({ workload, environment, secret })))
  );
}

test('the row table is the reviewed copy list', () => {
  assert.deepEqual(workflowRows(), COPY_LIST);
});

test('each row is a secret of its policy, in that policy folder and environment, and every policy secret has a row', () => {
  const targets = COPY_LIST.map(row => row.split(' ').slice(1).join(' ')).sort();
  const expected = snapshotRows()
    .map(({ workload, environment, secret }) => `${environment} /ci/${workload} ${secret}`)
    .sort();
  assert.deepEqual(targets, expected);
  // The GitHub secret carries the same name as its target.
  for (const row of COPY_LIST) {
    const [secret, , , name] = row.split(' ');
    assert.equal(secret, name, row);
  }
  assert.equal(new Set(targets).size, targets.length, 'no target is listed twice');
});

test('the policy files present match the snapshot', () => {
  const files = existsSync(POLICY_DIR)
    ? readdirSync(POLICY_DIR).filter(file => file.endsWith('.yaml'))
    : [];
  const policies = Object.fromEntries(
    files.map(file => [
      file.slice(0, -'.yaml'.length),
      load(readFileSync(join(POLICY_DIR, file), 'utf8')),
    ])
  );
  const present = Object.keys(POLICY_SNAPSHOT).filter(workload => policies[workload]);
  if (REQUIRE_POLICIES) {
    assert.deepEqual(present, Object.keys(POLICY_SNAPSHOT), 'every snapshot policy is present');
  }
  for (const workload of present) {
    const policy = policies[workload];
    assert.equal(policy.workload, workload);
    assert.equal(policy.identity.kind, 'github-oidc', workload);
    assert.equal(policy.identity.repository, 'Kilo-Org/cloud', workload);
    assert.deepEqual(
      { environments: policy.environments, secrets: policy.secrets },
      POLICY_SNAPSHOT[workload],
      workload
    );
  }
  // No other cloud CI policy reads one of the copied names: a renamed or split folder (a stage
  // policy shared by several projects, say) would leave the copy targeting a folder no job reads.
  const copied = new Set(COPY_LIST.map(row => row.split(' ')[3]));
  for (const [workload, policy] of Object.entries(policies)) {
    if (POLICY_SNAPSHOT[workload] || policy?.identity?.repository !== 'Kilo-Org/cloud') continue;
    for (const secret of policy.secrets ?? []) {
      assert.ok(
        !copied.has(secret),
        `${workload} reads ${secret}, which this copy does not target`
      );
    }
  }
});

const COMMIT_CHECK =
  '[[ $EXPECTED_COMMIT =~ ^[0-9a-f]{40}$ && $EXPECTED_COMMIT == "$GITHUB_SHA" ]] ||\n' +
  '  fail "expected_commit is not the dispatched commit $GITHUB_SHA"\n';
const EXPECTED_COMMIT_ENV = '${{ inputs.expected_commit }}';

test('runs only on a dispatch by iscekic on main, in the copy-secrets environment', () => {
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), [
    'mode',
    'expected_commit',
    'only',
  ]);
  assert.equal(workflow.on.workflow_dispatch.inputs.expected_commit.required, true);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.mode.options, ['copy', 'probe-login']);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, {
    group: 'copy-secrets-to-infisical',
    'cancel-in-progress': false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ['copy', 'probe-login']);
  for (const name of ['copy', 'probe-login']) {
    const job = workflow.jobs[name];
    assert.equal(job.needs, undefined, name);
    assert.equal(job.if, `${GATE} && inputs.mode == '${name}'`, name);
    assert.equal(job.environment, 'copy-secrets', name);
    assert.deepEqual(job.permissions, { 'id-token': 'write' }, name);
    assert.ok(job.steps[0].run.includes(`readonly AUDIENCE=${AUDIENCE}\n`), `${name}: audience`);
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-24.04', name);
    assert.equal(job.steps.length, 1, `${name}: one step, no checkout and no action`);
    assert.equal(job.steps[0].uses, undefined, name);
    assert.equal(job.steps[0].shell, 'bash --noprofile --norc -euo pipefail {0}', name);
    // Inputs and values reach the script through env only, never through an expression.
    assert.doesNotMatch(job.steps[0].run, /\$\{\{/, name);
    // Every job refuses a dispatch whose expected_commit is not the run's commit, before any
    // network call.
    assert.equal(job.steps[0].env.EXPECTED_COMMIT, EXPECTED_COMMIT_ENV, name);
    const run = job.steps[0].run;
    assert.ok(run.includes(COMMIT_CHECK), `${name}: expected_commit is checked`);
    const firstRequest = run.indexOf('jwt=$(curl ');
    assert.ok(firstRequest >= 0, `${name}: OIDC token request`);
    assert.ok(run.indexOf(COMMIT_CHECK) < firstRequest, `${name}: checked before any request`);
  }
  assert.ok(workflow.jobs.copy['timeout-minutes'] <= 10);
  assert.ok(workflow.jobs['probe-login']['timeout-minutes'] <= 5);
});

// The job token cannot read an environment's settings (that needs the administration
// permission), so the operator reads copy-secrets back before dispatch and no job tries.
test('no job calls the environments API with the job token', () => {
  assert.doesNotMatch(workflowText, /github\.token|secrets\.GITHUB_TOKEN/);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.permissions.actions, undefined, name);
    assert.equal(job.permissions.administration, undefined, name);
    for (const [index, step] of job.steps.entries()) {
      const text = JSON.stringify(step);
      const where = `${name} step ${index}`;
      assert.doesNotMatch(text, /GH_TOKEN|GITHUB_TOKEN|GITHUB_API_URL|api\.github\.com/, where);
      assert.doesNotMatch(text, /\/environments\b|deployment-branch-policies/, where);
    }
  }
});

const IDENTITY_ENV = '${{ secrets.COPY_IDENTITY_ID }}';
const IDENTITY_EMPTY_ERROR =
  '::error::secret COPY_IDENTITY_ID of the copy-secrets environment is missing or empty';

// The script of a job up to its first request (the OIDC token request).
function beforeFirstRequest(run, name) {
  const end = run.indexOf('aud=$(');
  assert.ok(end >= 0 && end < run.indexOf('jwt=$(curl '), `${name}: aud precedes the OIDC request`);
  assert.equal(run.indexOf('aud=$(', end + 1), -1, `${name}: one aud`);
  return run.slice(0, end);
}

function runPrefix(prefix, identityId) {
  const sha = 'a'.repeat(40);
  return spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', prefix], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      EXPECTED_COMMIT: sha,
      GITHUB_SHA: sha,
      IDENTITY_ID: identityId,
      ONLY: '',
    },
  });
}

// The identity id exists only as a secret of the copy-secrets environment. A dispatch that
// auto-creates a deleted environment gets no secrets, so both jobs stop before any request.
test('both jobs take the identity id from the environment secret and refuse an empty one', () => {
  assert.doesNotMatch(workflowText, /inputs\.identity_id/);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const step = job.steps[0];
    assert.equal(step.env.IDENTITY_ID, IDENTITY_ENV, name);
    assert.ok(step.run.includes(`fail "${IDENTITY_EMPTY_ERROR.slice('::error::'.length)}"`), name);
    // The id reaches jq through $ENV and is never printed, only a hash prefix of it.
    assert.match(step.run, /jq -Rc '\{identityId: \$ENV\.IDENTITY_ID, jwt: \.\}'/, name);
    assert.doesNotMatch(step.run, /--arg id|echo "[^"\n]*\$IDENTITY_ID/, name);
    const prefix = beforeFirstRequest(step.run, name);
    const empty = runPrefix(prefix, '');
    assert.equal(empty.status, 1, `${name}: empty id refused`);
    assert.ok(
      empty.stdout.includes(IDENTITY_EMPTY_ERROR),
      `${name}: ${empty.stdout}${empty.stderr}`
    );
    const upper = runPrefix(prefix, '0000000A-0000-4000-8000-000000000000');
    assert.equal(upper.status, 1, `${name}: uppercase id refused`);
    assert.ok(
      upper.stdout.includes('::error::secret COPY_IDENTITY_ID is not a lowercase UUID'),
      name
    );
    const id = '0000000a-0000-4000-8000-000000000000';
    const valid = runPrefix(prefix, id);
    assert.ok(
      valid.stdout.includes('identity_id_sha256='),
      `${name}: ${valid.stdout}${valid.stderr}`
    );
    assert.ok(!valid.stdout.includes('COPY_IDENTITY_ID'), `${name}: a valid id passes the checks`);
    assert.ok(!valid.stdout.includes(id), `${name}: the id is not printed`);
  }
});

test('the probe job holds only the identity id secret', () => {
  assert.deepEqual(probeStep.env, {
    EXPECTED_COMMIT: EXPECTED_COMMIT_ENV,
    IDENTITY_ID: IDENTITY_ENV,
  });
  const secrets = [...JSON.stringify(workflow.jobs['probe-login']).matchAll(/secrets\.(\w+)/g)];
  assert.deepEqual(
    secrets.map(match => match[1]),
    ['COPY_IDENTITY_ID']
  );
});

test('the copy step binds only the copied secrets and creates only', () => {
  const secretEnv = Object.keys(copyStep.env)
    .filter(key => key.startsWith('V_'))
    .sort();
  const used = [...new Set(COPY_LIST.map(row => `V_${row.split(' ')[0]}`))].sort();
  assert.deepEqual(secretEnv, used);
  assert.deepEqual(
    Object.keys(copyStep.env).filter(key => !key.startsWith('V_')),
    ['EXPECTED_COMMIT', 'IDENTITY_ID', 'ONLY']
  );
  assert.equal(copyStep.env.IDENTITY_ID, IDENTITY_ENV);
  assert.equal(
    Object.values(copyStep.env).filter(binding => binding.includes('secrets.')).length,
    used.length + 1
  );
  const run = copyStep.run;
  // One POST per target to the v4 create endpoint; no update, delete or retry flag.
  assert.match(run, /"\$ORIGIN\/api\/v4\/secrets\/\$name"\) \|\| resp=/);
  assert.doesNotMatch(run, /-X\s|--request|PATCH|DELETE|--retry/);
  assert.match(run, /trap revoke EXIT/);
  assert.match(run, /api\/v1\/auth\/token\/revoke/);
  assert.match(run, /echo "COPY_VERIFY \$env \$path \$name match=true"/);
  // Values reach jq through $ENV, never through --arg.
  assert.doesNotMatch(run, /--arg [a-z]+ "\$\{!var\}"|\$V_[A-Z]/);
});

test('the header says to delete the workflow after its run', () => {
  assert.match(workflowText, /^# ONE-SHOT\. Delete this file/m);
});
