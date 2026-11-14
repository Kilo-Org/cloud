import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

async function launch(publicationStatus = 0, args = ['--env', 'dev']) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'runtime-local-start-'));
  temporary.push(directory);
  for (const [name, script] of Object.entries({
    pnpm: `printf 'publish:%s\\n' "$*"; exit ${publicationStatus}`,
    node: `case "$*" in *KILO2*) printf '${'b'.repeat(64)}' ;; *) printf '${'a'.repeat(64)}' ;; esac`,
    wrangler: 'printf "wrangler:%s\\n" "$@"',
  })) {
    await writeFile(path.join(directory, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  }
  return spawnSync(
    '/bin/sh',
    [path.join(root, 'scripts/dev.sh'), ...args, '--config', 'custom.json'],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        MINIFLARE_CONTAINER_EGRESS_IMAGE: 'local-test',
      },
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    }
  );
}

it('publishes locally before starting Wrangler with downloaded descriptors and shared persistence', async () => {
  const result = await launch();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(`publish:exec tsx ${root}/scripts/publish-runtime.ts --local`);
  expect(result.stdout).toContain('wrangler:custom.json');
  expect(result.stdout).toContain(`wrangler:${root}/.wrangler/state`);
  expect(result.stdout).toContain('wrangler:RUNTIME_STARTUP_MODE:downloaded');
  expect(result.stdout).toContain('wrangler:NATIVE_RUNTIME_IMAGE:runtime-free');
  expect(result.stdout).toContain(`wrangler:RUNTIME_RELEASE_DESCRIPTOR:${'a'.repeat(64)}`);
  expect(result.stdout).toContain(`wrangler:RUNTIME_RELEASE_DESCRIPTOR_KILO2:${'b'.repeat(64)}`);
  expect(result.stdout.indexOf('publish:')).toBeLessThan(result.stdout.indexOf('wrangler:'));
});

it('does not start a Worker when local publication fails', async () => {
  const result = await launch(1);
  expect(result.status).toBe(1);
  expect(result.stdout).not.toContain('wrangler:');
});

it('defaults start to the same dev environment as local publication', async () => {
  const result = await launch(0, []);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('wrangler:--env\nwrangler:dev\n');
  expect(result.stdout).toContain(`publish:exec tsx ${root}/scripts/publish-runtime.ts --local`);
});

it.each([['--env=dev'], ['-e', 'dev']])('preserves explicit dev selection %s', async (...args) => {
  const result = await launch(0, args);
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('wrangler:--env\n');
});

it.each([['--env', 'production'], ['--env=staging'], ['-e', 'production']])(
  'rejects a different publication environment %s',
  async (...args) => {
    const result = await launch(0, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires the dev environment');
    expect(result.stdout).not.toContain('publish:');
    expect(result.stdout).not.toContain('wrangler:');
  }
);

it('does not expose an unprepared package deploy entrypoint', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  expect(manifest.scripts.deploy).toBeUndefined();
});
