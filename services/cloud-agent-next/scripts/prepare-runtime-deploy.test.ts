import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from './prepare-runtime-deploy.js';

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn(async () => {
    throw new Error('Unexpected publication lookup');
  }),
}));
vi.mock('./runtime-publish-store.js', () => ({
  remoteArtifactStore: () => ({ getBytes: lookup }),
}));
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  lookup.mockClear();
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function checkout(config: string, recipe?: string, mode = 'downloaded') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-deploy-preflight-'));
  temporary.push(root);
  await fs.writeFile(path.join(root, 'wrangler.jsonc'), config);
  await fs.writeFile(
    path.join(root, 'runtime-targets.json'),
    JSON.stringify({
      default: { mode, image: 'all-in-one' },
      targets: {},
    })
  );
  if (recipe !== undefined)
    await fs.writeFile(path.join(root, 'Dockerfile.containers.runtime-free'), recipe);
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Test checkout setup failed');
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  git([
    'add',
    'wrangler.jsonc',
    'runtime-targets.json',
    ...(recipe === undefined ? [] : ['Dockerfile.containers.runtime-free']),
  ]);
  git([
    '-c',
    'user.name=Runtime Test',
    '-c',
    'user.email=runtime@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  vi.stubEnv('RUNTIME_PUBLICATION_ENABLED', 'true');
  vi.stubEnv('RUNTIME_R2_ACCOUNT_ID', 'c'.repeat(32));
  vi.stubEnv('RUNTIME_R2_BUCKET', 'runtime-test');
  vi.stubEnv('RUNTIME_R2_ACCESS_KEY_ID', 'fixture-key');
  vi.stubEnv('RUNTIME_R2_SECRET_ACCESS_KEY', 'fixture-secret');
  vi.stubEnv('GITHUB_OUTPUT', '');
  return { root, sha: git(['rev-parse', 'HEAD']) };
}
const config = () =>
  JSON.stringify({
    vars: {},
    r2_buckets: [{ binding: 'RUNTIME_RELEASE_BUCKET', bucket_name: 'runtime-test' }],
    containers: [
      {
        class_name: 'SandboxContainers',
        images: { app: { dockerfile: './Dockerfile.containers' } },
      },
    ],
  });
for (const recipe of [undefined, 'FROM debian:trixie-slim\nCOPY undeclared /tmp/file\n'])
  it(`rejects ${recipe === undefined ? 'missing' : 'undeclared'} base inputs before publication lookup`, async () => {
    const f = await checkout(config(), recipe);
    await expect(main(['production', f.sha], f.root)).rejects.toThrow(
      recipe === undefined ? 'ENOENT' : 'Declare and hash'
    );
    expect(lookup).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(f.root, 'wrangler.runtime-generated.json'))
    ).rejects.toHaveProperty('code', 'ENOENT');
  });
it('fails a downloaded deployment promptly when publication is disabled', async () => {
  const f = await checkout(config());
  vi.stubEnv('RUNTIME_PUBLICATION_ENABLED', '');
  await expect(main(['production', f.sha], f.root)).rejects.toThrow(
    'Runtime publication is not enabled'
  );
  expect(lookup).not.toHaveBeenCalled();
});
it('rejects malformed JSONC before writing a deploy configuration', async () => {
  const f = await checkout(config().slice(0, -1), undefined, 'preinstalled');
  await expect(main(['production', f.sha], f.root)).rejects.toThrow('Invalid wrangler.jsonc');
  expect(lookup).not.toHaveBeenCalled();
  await expect(
    fs.stat(path.join(f.root, 'wrangler.runtime-generated.json'))
  ).rejects.toHaveProperty('code', 'ENOENT');
});
it('accepts JSONC comments and trailing commas without runtime storage in preinstalled mode', async () => {
  const f = await checkout(
    config().slice(0, -1) + ', // supported JSONC\n}',
    undefined,
    'preinstalled'
  );
  await expect(main(['production', f.sha], f.root)).resolves.toBeUndefined();
  expect(lookup).not.toHaveBeenCalled();
});
