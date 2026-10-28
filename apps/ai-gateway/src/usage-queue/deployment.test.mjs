import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const callbackPath = 'src/app/api/v1/internal/queues/usage/route.ts';
const templatePath = 'src/usage-queue/route.ts';
const targets = [
  ['unknown target', {}, false],
  ['CI staging target', { TARGET_ENVIRONMENT: 'staging' }, true],
  ['hosted staging target', { VERCEL_TARGET_ENV: 'staging', VERCEL_ENV: 'preview' }, true],
  [
    'consistent staging targets',
    { TARGET_ENVIRONMENT: 'staging', VERCEL_TARGET_ENV: 'staging' },
    true,
  ],
  ['production target', { TARGET_ENVIRONMENT: 'production' }, false],
  ['hosted production', { VERCEL_TARGET_ENV: 'production', VERCEL_ENV: 'production' }, false],
  ['preview target', { VERCEL_TARGET_ENV: 'preview', VERCEL_ENV: 'preview' }, false],
  [
    'conflicting targets',
    { TARGET_ENVIRONMENT: 'staging', VERCEL_TARGET_ENV: 'production' },
    false,
  ],
  [
    'production overrides staging',
    { TARGET_ENVIRONMENT: 'staging', VERCEL_TARGET_ENV: 'staging', VERCEL_ENV: 'production' },
    false,
  ],
  ['misspelled target', { TARGET_ENVIRONMENT: 'STAGING' }, false],
];

for (const [name, env, staging] of targets) {
  test(name, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'usage-queue-target-'));
    const runEnv = { PATH: process.env.PATH, ...env };
    try {
      for (const file of [
        'vercel.mjs',
        'src/usage-queue/deployment.mjs',
        'src/usage-queue/prepare.mjs',
        templatePath,
      ]) {
        mkdirSync(dirname(join(fixture, file)), { recursive: true });
        copyFileSync(join(import.meta.dirname, '../..', file), join(fixture, file));
      }
      // A stale staging callback must also disappear on non-staging builds.
      mkdirSync(dirname(join(fixture, callbackPath)), { recursive: true });
      copyFileSync(join(fixture, templatePath), join(fixture, callbackPath));
      execFileSync(process.execPath, ['src/usage-queue/prepare.mjs'], {
        cwd: fixture,
        env: runEnv,
      });
      assert.equal(existsSync(join(fixture, callbackPath)), staging);
      const config = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "const {config}=await import('./vercel.mjs'); console.log(JSON.stringify(config));",
          ],
          {
            cwd: fixture,
            env: runEnv,
            encoding: 'utf8',
          }
        )
      );
      assert.deepEqual(config.regions, ['fra1', 'sfo1']);
      assert.equal(config.buildCommand, 'pnpm run build');
      const trigger = config.functions?.[callbackPath];
      if (staging) {
        assert.equal(
          readFileSync(join(fixture, callbackPath), 'utf8'),
          readFileSync(join(fixture, templatePath), 'utf8')
        );
        assert.deepEqual(trigger.regions, ['fra1']);
        assert.equal(trigger.experimentalTriggers[0].type, 'queue/v2beta');
        assert.equal(trigger.experimentalTriggers[0].maxConcurrency, 200);
      } else {
        assert.equal(config.functions, undefined);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
}
