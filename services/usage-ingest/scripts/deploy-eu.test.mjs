import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import yaml from 'js-yaml';

test('selected-source EU guards preserve relay ordering, historical staging and production on both initial/retry paths', async t => {
  const workflow = yaml.load(
    await readFile(
      new URL('../../../.github/workflows/deploy-workers.yml', import.meta.url),
      'utf8'
    )
  );
  const historicalConfig = await readFile(
    new URL('../test/fixtures/pre-eu/wrangler.jsonc', import.meta.url),
    'utf8'
  );
  const historicalPackage = await readFile(
    new URL('../test/fixtures/pre-eu/package.json', import.meta.url),
    'utf8'
  );
  const currentConfig = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const currentPackage = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const helper = await readFile(new URL('./eu-queues.mjs', import.meta.url), 'utf8');
  const relayConfig = await readFile(
    new URL('../wrangler.writer-relay.jsonc', import.meta.url),
    'utf8'
  );
  const historicalDirect = historicalConfig.replace(/^\s*"services":.*\n/m, '');
  assert.notEqual(historicalDirect, historicalConfig);
  const temp = await mkdtemp(join(tmpdir(), 'staging-eu-source-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, 'scripts'));
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(temp, 'node_modules'),
    'dir'
  );
  const environment = {
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: join(temp, 'config'),
    WRANGLER_LOG_PATH: join(temp, 'logs'),
    WRANGLER_SEND_METRICS: 'false',
    GITHUB_OUTPUT: join(temp, 'output'),
  };
  const cases = [
    {
      name: 'historical-direct',
      config: historicalDirect,
      pkg: historicalPackage,
      success: true,
      required: false,
      relayRequired: false,
      missingRelay: true,
    },
    {
      name: 'historical-relay',
      config: historicalConfig,
      pkg: historicalPackage,
      success: true,
      required: false,
    },
    { name: 'EU-missing-helper', config: currentConfig, pkg: historicalPackage, checkFails: true },
    {
      name: 'declared-guard-missing',
      config: historicalConfig,
      pkg: currentPackage,
      checkFails: true,
    },
    { name: 'malformed-config', config: '{', pkg: historicalPackage, checkFails: true },
    {
      name: 'missing-required-relay',
      config: currentConfig,
      pkg: currentPackage,
      helper,
      missingRelay: true,
      checkFails: true,
    },
    {
      name: 'broken-EU-helper',
      config: currentConfig,
      pkg: currentPackage,
      helper: 'export {;',
      required: true,
    },
    {
      name: 'real-EU-helper-invoked',
      config: currentConfig,
      pkg: currentPackage,
      helper,
      required: true,
      error: /CLOUDFLARE_API_TOKEN is required/,
    },
  ];
  let attempts = 0;
  for (const job of ['deploy-manual', 'deploy-changed']) {
    const steps = workflow.jobs[job].steps;
    const checkIndex = steps.findIndex(s => s.id === 'usage_relay');
    const relayIndex = steps.findIndex(s => s.name === 'Deploy private staging usage writer relay');
    const uploadIndex = steps.findIndex(s => s.id === 'deploy');
    assert.ok(checkIndex < relayIndex && relayIndex < uploadIndex);
    const check = steps[checkIndex];
    assert.match(check.if, /target_environment == 'staging'/);
    const uploads = steps.filter(
      s => s.id === 'deploy' || s.name === 'Deploy to Cloudflare Workers (retry)'
    );
    assert.equal(uploads.length, 2);
    for (const upload of uploads) {
      assert.match(
        upload.with.command,
        /target_environment == 'staging' && '--experimental-provision=false'/
      );
    }
    for (const scenario of cases) {
      await writeFile(join(temp, 'wrangler.jsonc'), scenario.config);
      await writeFile(join(temp, 'package.json'), scenario.pkg);
      await writeFile(environment.GITHUB_OUTPUT, '');
      if (scenario.helper === undefined)
        await rm(join(temp, 'scripts/eu-queues.mjs'), { force: true });
      else await writeFile(join(temp, 'scripts/eu-queues.mjs'), scenario.helper);
      if (scenario.missingRelay)
        await rm(join(temp, 'wrangler.writer-relay.jsonc'), { force: true });
      else await writeFile(join(temp, 'wrangler.writer-relay.jsonc'), relayConfig);
      const checked = spawnSync('bash', ['-c', check.run], {
        cwd: temp,
        env: environment,
        encoding: 'utf8',
      });
      if (scenario.checkFails) {
        assert.notEqual(
          checked.status,
          0,
          `${job}/${scenario.name}: unsafe source reached relay deploy`
        );
        continue;
      }
      assert.equal(checked.status, 0, checked.stderr);
      const output = await readFile(environment.GITHUB_OUTPUT, 'utf8');
      assert.ok(output.split('\n').includes(`required=${scenario.relayRequired ?? true}`));
      assert.ok(output.includes(`eu_required=${scenario.required}`));
      for (const [index, upload] of uploads.entries()) {
        const shell = upload.with.preCommands.replaceAll(
          '${{ steps.usage_relay.outputs.eu_required }}',
          String(scenario.required)
        );
        // Match wrangler-action: each nonempty preCommands line is a separate shell.
        let result;
        for (const command of shell.trim().split('\n')) {
          result = spawnSync('bash', ['-c', command], {
            cwd: temp,
            env: environment,
            encoding: 'utf8',
          });
          if (result.status !== 0) break;
        }
        assert.equal(
          result.status,
          scenario.success ? 0 : 1,
          `${job}/${scenario.name}/attempt${index + 1}: ${result.stderr}`
        );
        if (scenario.error) assert.match(result.stderr, scenario.error);
        attempts++;
        t.diagnostic(
          JSON.stringify({
            job,
            scenario: scenario.name,
            attempt: index + 1,
            status: result.status,
          })
        );
      }
    }
    // Production and unrelated Workers skip this staging-only classifier and EU guard.
    for (const upload of uploads) {
      const shell = upload.with.preCommands.replaceAll(
        '${{ steps.usage_relay.outputs.eu_required }}',
        ''
      );
      const result = spawnSync('bash', ['-c', `${shell}\nprintf UNCHANGED_PATH`], {
        cwd: temp,
        env: environment,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /UNCHANGED_PATH/);
    }
  }
  assert.equal(attempts, 16);
  const discovery = workflow.jobs['detect-changes'].steps
    .find(s => s.id === 'set-matrix')
    .run.match(/done < <\((find services[^\n]+)\)/)?.[1];
  assert.ok(discovery);
  const discovered = spawnSync('bash', ['-c', discovery], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    encoding: 'utf8',
  });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.ok(!discovered.stdout.includes('/test/fixtures/'));
  assert.ok(discovered.stdout.includes('services/usage-ingest/wrangler.jsonc'));
});
