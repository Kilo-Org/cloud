import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const targets = [
  ['unknown target', {}],
  ['CI staging target', { TARGET_ENVIRONMENT: 'staging' }],
  ['hosted staging target', { VERCEL_TARGET_ENV: 'staging', VERCEL_ENV: 'preview' }],
  [
    'hosted staging with the legacy queue selector',
    { VERCEL_TARGET_ENV: 'staging', VERCEL_ENV: 'preview', USAGE_QUEUE_TRANSPORT: 'vercel' },
  ],
  ['CI production target', { TARGET_ENVIRONMENT: 'production' }],
  ['hosted production', { VERCEL_TARGET_ENV: 'production', VERCEL_ENV: 'production' }],
  ['preview target', { VERCEL_TARGET_ENV: 'preview', VERCEL_ENV: 'preview' }],
];

for (const [name, env] of targets) {
  test(`${name} builds the ordinary gateway without queue callbacks or triggers`, () => {
    const config = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const {config}=await import('./vercel.mjs'); console.log(JSON.stringify(config));",
        ],
        { cwd: import.meta.dirname, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }
      )
    );
    assert.deepEqual(config, {
      buildCommand: 'pnpm run build',
      regions: ['fra1', 'sfo1'],
      skipMiddlewareRequestBody: true,
    });
  });
}

test('the build script runs only the Next build', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.build, 'next build');
});
