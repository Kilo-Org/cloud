import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { load } from 'js-yaml';

const read = async name =>
  load(await fs.readFile(new URL('../../../.github/workflows/' + name, import.meta.url), 'utf8'));
test('write credentials follow admission and checkout uses its exact SHA', async () => {
  const workflow = await read('cloud-agent-runtime-publish.yml');
  assert.deepEqual(workflow.on, {
    workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] },
  });
  assert.equal(workflow.jobs.admit.if, "github.event.workflow_run.conclusion == 'success'");
  assert.deepEqual(workflow.jobs.publish.needs, 'admit');
  assert.equal(workflow.jobs.publish.if, "vars.CLOUD_AGENT_RUNTIME_PUBLICATION_ENABLED == 'true'");
  assert.equal(workflow.jobs.publish.environment, 'cloud-agent-runtime-publication');
  assert.ok(!JSON.stringify(workflow.jobs.admit).includes('secrets.'));
  assert.equal(workflow.jobs.admit.steps[0].with.ref, 'refs/heads/main');
  const steps = workflow.jobs.publish.steps;
  assert.equal(steps[0].with.ref, '${{ needs.admit.outputs.source_sha }}');
  const publish = steps.find(
    step => step.name === 'Publish verified runtime and exact-SHA handoff'
  );
  assert.equal(publish.env.SOURCE_SHA, '${{ needs.admit.outputs.source_sha }}');
  assert.match(publish.run, /runtime:publish.*--source-sha "\$SOURCE_SHA"/);
  assert.equal(workflow.jobs.publish.concurrency['cancel-in-progress'], false);
  assert.equal(
    workflow.jobs.publish.concurrency.group,
    'cloud-agent-runtime-publisher-${{ needs.admit.outputs.source_sha }}'
  );
});
test('both Worker deployment paths verify runtime before custom build and Wrangler', async () => {
  const workflow = await read('deploy-workers.yml');
  for (const name of ['deploy-manual', 'deploy-changed']) {
    const steps = workflow.jobs[name].steps;
    const prepare = steps.findIndex(step => step.id === 'runtime');
    const deploy = steps.findIndex(step => step.name === 'Deploy to Cloudflare Workers');
    assert.ok(prepare >= 0 && prepare < deploy);
    assert.match(steps[prepare].if, /== 'services\/cloud-agent-next'/);
    assert.equal(steps[prepare].env.SOURCE_SHA, '${{ inputs.source_sha || github.sha }}');
    assert.match(steps[deploy].with.command, /steps.runtime.outputs.command/);
    assert.match(steps[deploy].with.preCommands, /predeploy/);
    assert.equal(
      steps.find(step => step.name === 'Checkout code').with.ref,
      '${{ inputs.source_sha || github.sha }}'
    );
  }
  assert.equal(workflow.jobs['deploy-changed'].strategy['fail-fast'], false);
  const publisher = await read('cloud-agent-runtime-publish.yml');
  assert.notEqual(workflow.concurrency.group, publisher.jobs.publish.concurrency.group);
});

test('workflow-only changes still run runtime admission checks', async () => {
  const ci = await read('ci.yml');
  const check = ci.jobs.changes.steps.find(
    step => step.name === 'Check runtime publication workflow admission'
  );
  assert.equal(check.run, 'pnpm --filter cloud-agent-next test:runtime-ci');
  assert.equal(check.if, undefined);
});

test('legacy exact-SHA deployments skip absent runtime tooling and current targets still enforce it', async () => {
  const workflow = await read('deploy-workers.yml');
  for (const job of ['deploy-manual', 'deploy-changed']) {
    const step = workflow.jobs[job].steps.find(step => step.id === 'runtime');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-legacy-deploy-'));
    try {
      const bin = path.join(root, 'bin');
      await fs.mkdir(bin);
      const trace = path.join(root, 'invocation.json');
      await fs.writeFile(
        path.join(bin, 'pnpm'),
        '#!' +
          process.execPath +
          '\nrequire("node:fs").writeFileSync(process.env.RUNTIME_CLI_TRACE,JSON.stringify(process.argv.slice(2)));process.exit(17);\n',
        { mode: 0o755 }
      );
      const run = () =>
        spawnSync('bash', ['-e', '-c', step.run], {
          cwd: root,
          encoding: 'utf8',
          timeout: 3000,
          env: {
            ...process.env,
            PATH: bin + path.delimiter + process.env.PATH,
            RUNTIME_CLI_TRACE: trace,
            TARGET_ENVIRONMENT: 'production',
            SOURCE_SHA: 'a'.repeat(40),
          },
        });
      assert.equal(run().status, 0, 'a legacy checkout has no runtime script or catalog');
      await assert.rejects(fs.access(trace));
      await fs.writeFile(path.join(root, 'runtime-targets.json'), '{}');
      assert.equal(run().status, 17, 'a current catalog must not bypass missing preparation');
      await fs.rm(path.join(root, 'runtime-targets.json'));
      await fs.mkdir(path.join(root, 'scripts'));
      await fs.writeFile(path.join(root, 'scripts/prepare-runtime-deploy.ts'), 'fixture');
      assert.equal(run().status, 17, 'existing preparation failures must stop deployment');
      assert.deepEqual(JSON.parse(await fs.readFile(trace, 'utf8')), [
        'exec',
        'tsx',
        'scripts/prepare-runtime-deploy.ts',
        'production',
        'a'.repeat(40),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
