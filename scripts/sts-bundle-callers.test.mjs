// Holds every job that reads an STS bundle with .github/actions/sts-bundle to the
// rules in that action's README: its STS policy names its workflow file, its
// environment and its events; it installs nothing; every step before the read is
// trusted; each value reaches a step's `env:` (or an action's input) and never a
// command line; the migrated GitHub secrets have no reader left; and the reusable
// workflows that read a bundle keep exactly their reviewed callers.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { load } from 'js-yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const POLICIES = new URL('../services/sts/policy/', import.meta.url);
// The action from the run's checkout, or from a side checkout of the run's commit
// where the job's main checkout is another commit (stage-vercel-deployment.yml).
const ACTIONS = ['./.github/actions/sts-bundle', './sts-action/.github/actions/sts-bundle'];
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

const isRead = step => ACTIONS.includes(step.uses);
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
          if (file !== 'cloud-agent-sentry-sourcemaps.yml') {
            // The Vercel CLI comes from this run's install-vercel-cli.yml job, which holds no id-token.
            assert.equal(job.with.vercel_cli_artifact, '${{ needs.vercel-cli.outputs.artifact }}');
            // Its digest comes from the same job, and the reader checks it before unpacking.
            assert.equal(job.with.vercel_cli_sha256, '${{ needs.vercel-cli.outputs.sha256 }}');
            const install = document.jobs['vercel-cli'];
            assert.equal(install.uses, './.github/workflows/install-vercel-cli.yml', caller);
            assert.deepEqual(install.permissions, {}, `${caller}: the CLI install holds no token`);
          }
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

test('the shared Vercel CLI install holds no id-token and is only called', () => {
  const install = workflows['install-vercel-cli.yml'];
  assert.deepEqual(Object.keys(install.on), ['workflow_call']);
  assert.deepEqual(install.permissions, {});
  for (const job of Object.values(install.jobs)) {
    assert.deepEqual(job.permissions, {});
    assert.ok(!(job.steps ?? []).some(isRead));
  }
});

test('the stage job reads its bundle with the action of the run commit, before the deployed commit', () => {
  const steps = workflows['stage-vercel-deployment.yml'].jobs.stage.steps;
  const side = steps.findIndex(step => step.with?.path === 'sts-action');
  assert.equal(steps[side].with.ref, '${{ github.sha }}');
  assert.equal(steps[side].with['sparse-checkout'], '.github/actions/sts-bundle');
  const read = steps.findIndex(isRead);
  const source = steps.findIndex(
    step => step.with?.ref === '${{ inputs.source_sha || github.sha }}'
  );
  assert.ok(side < read && read < source, 'side checkout, read, then the deployed commit');
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

test('the Vercel CLI and app closure hand-offs are per attempt and digest-checked before unpacking', () => {
  const install = workflows['install-vercel-cli.yml'].jobs.install;
  assert.equal(install.outputs.artifact, 'vercel-cli-${{ github.run_attempt }}');
  assert.equal(install.outputs.sha256, '${{ steps.pack.outputs.sha256 }}');
  const upload = install.steps.find(step => /upload-artifact/.test(step.uses ?? ''));
  assert.equal(upload.with.name, 'vercel-cli-${{ github.run_attempt }}');
  assert.equal(upload.with.overwrite, undefined);
  for (const [file, job, expected] of [
    ['stage-vercel-deployment.yml', 'stage', '${{ inputs.vercel_cli_sha256 }}'],
    ['promote-vercel-deployment.yml', 'promote', '${{ inputs.vercel_cli_sha256 }}'],
    ['kilo-app-release.yml', 'preflight', '${{ needs.app-workspace.outputs.sha256 }}'],
    ['kilo-app-release.yml', 'build-and-submit', '${{ needs.app-workspace.outputs.sha256 }}'],
  ]) {
    const steps = workflows[file].jobs[job].steps;
    const unpack = steps.find(step => /tar (-I zstd )?-x/.test(step.run ?? ''));
    assert.ok(Object.values(unpack.env ?? {}).includes(expected), `${file}#${job} gets the digest`);
    const run = unpack.run;
    assert.ok(run.indexOf('sha256sum --check') < run.search(/tar (-I zstd )?-x/), `${file}#${job}`);
    const download = steps.find(step => /download-artifact/.test(step.uses ?? ''));
    // The name comes from the producer's output, never from the consumer's own attempt.
    assert.ok(
      ['${{ inputs.vercel_cli_artifact }}', '${{ needs.app-workspace.outputs.artifact }}'].includes(
        download.with.name
      ),
      `${file}#${job}`
    );
  }
  const app = workflows['kilo-app-release.yml'].jobs['app-workspace'];
  assert.equal(app.outputs.sha256, '${{ steps.pack.outputs.sha256 }}');
  const appUpload = app.steps.find(step => /upload-artifact/.test(step.uses ?? ''));
  assert.equal(appUpload.with.name, 'kilo-app-node-modules-${{ github.run_attempt }}');
  assert.equal(appUpload.with.overwrite, undefined);
});

test('the Sentry hand-off check refuses anything but the staged files', () => {
  const work = mkdtempSync(join(tmpdir(), 'sentry-handoff-'));
  const check = archive =>
    spawnSync('bash', ['scripts/ci/check-sentry-handoff.sh', archive], { encoding: 'utf8' });
  try {
    const pack = (name, setup) => {
      const root = join(work, name);
      mkdirSync(join(root, '0'), { recursive: true });
      writeFileSync(join(root, 'uploads.json'), '[]');
      writeFileSync(join(root, 'sentry-cli'), 'binary');
      writeFileSync(join(root, '0', 'index.js'), 'code');
      writeFileSync(join(root, '0', 'index.js.map'), '{}');
      setup?.(root);
      const archive = join(work, `${name}.tgz`);
      execFileSync('tar', ['-czf', archive, '-C', root, '.']);
      return archive;
    };
    assert.equal(check(pack('clean')).status, 0, 'the staged layout passes');
    for (const [name, setup] of [
      ['dotfile', root => writeFileSync(join(root, '.sentryclirc'), '[defaults]\nurl=https://x')],
      ['nested-dotfile', root => writeFileSync(join(root, '0', '.env'), 'SENTRY_URL=https://x')],
      ['properties', root => writeFileSync(join(root, 'sentry.properties'), 'defaults.url=x')],
      ['symlink', root => symlinkSync('/etc/passwd', join(root, '0', 'link.js'))],
      ['other-file', root => writeFileSync(join(root, '0', 'notes.txt'), 'x')],
    ]) {
      const result = check(pack(name, setup));
      assert.notEqual(result.status, 0, `${name} is refused`);
      assert.match(result.stderr, /::error title=sentry-handoff::/, name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('the Sentry hand-off check refuses absolute and parent paths, extra files and parent config', () => {
  const work = mkdtempSync(join(tmpdir(), 'sentry-handoff-more-'));
  const check = (...args) =>
    spawnSync('bash', ['scripts/ci/check-sentry-handoff.sh', ...args], { encoding: 'utf8' });
  try {
    const root = join(work, 'root');
    mkdirSync(join(root, '0'), { recursive: true });
    writeFileSync(join(root, 'uploads.json'), '[]');
    writeFileSync(join(root, 'sentry-cli'), 'binary');
    writeFileSync(join(root, '0', 'x.js'), 'code');
    for (const [name, target] of [
      ['absolute', '/etc/x.js'],
      ['dotdot', '../x.js'],
    ]) {
      const archive = join(work, `${name}.tgz`);
      execFileSync('tar', [
        '-czf',
        archive,
        '-P',
        `--transform=s,^\\./0/x\\.js$,${target},`,
        '-C',
        root,
        '.',
      ]);
      assert.match(
        execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }),
        new RegExp(target.replace(/[./]/g, '\\$&'))
      );
      const result = check(archive);
      assert.notEqual(result.status, 0, `${name} is refused`);
      assert.match(result.stderr, /::error title=sentry-handoff::/, name);
    }

    // The downloaded artifact must hold exactly one regular file.
    const artifact = join(work, 'artifact');
    mkdirSync(artifact);
    writeFileSync(join(artifact, 'cloud-agent-sentry.tgz'), 'x');
    assert.equal(check('--artifact', artifact).status, 0);
    writeFileSync(join(artifact, '.sentryclirc'), 'x');
    assert.notEqual(check('--artifact', artifact).status, 0, 'a second file is refused');

    // A .sentryclirc or sentry.properties in the working directory or any parent is refused.
    const nested = join(work, 'parent', 'child');
    mkdirSync(nested, { recursive: true });
    assert.equal(check('--workdir', nested).status, 0);
    writeFileSync(join(work, 'parent', '.sentryclirc'), '[defaults]\nurl=https://x');
    const parent = check('--workdir', nested);
    assert.notEqual(parent.status, 0, 'a parent .sentryclirc is refused');
    assert.match(parent.stderr, /sentryclirc exists/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
