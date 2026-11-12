import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, waitForRuntimeHandoff } from './prepare-runtime-deploy.js';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';

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
  vi.useRealTimers();
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
      default: { mode, image: 'runtime-free' },
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
        images: { 'runtime-free': { dockerfile: './Dockerfile.containers.runtime-free' } },
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
it('rejects malformed JSONC before writing a deploy configuration', async () => {
  const f = await checkout(config().slice(0, -1), undefined, 'preinstalled');
  await expect(main(['production', f.sha], f.root)).rejects.toThrow('Invalid wrangler.jsonc');
  expect(lookup).not.toHaveBeenCalled();
  await expect(
    fs.stat(path.join(f.root, 'wrangler.runtime-generated.json'))
  ).rejects.toHaveProperty('code', 'ENOENT');
});
describe('exact-SHA handoff wait', () => {
  const sha = 'e'.repeat(40);
  const handoffStore = (reads: Array<Uint8Array | null>) => {
    const getBytes = vi.fn(async () => (reads.length > 1 ? reads.shift() : reads[0]) ?? null);
    return { getBytes, putIfAbsent: vi.fn() } satisfies ArtifactObjectStore;
  };

  it('fails on the first probe once the publication can no longer produce a handoff', async () => {
    const store = handoffStore([null]);
    const probe = vi.fn(async () => 'Runtime publication finished without a handoff');
    await expect(waitForRuntimeHandoff(store, sha, probe)).rejects.toThrow(
      'Runtime publication finished without a handoff'
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('accepts a handoff written just before the publication run completed', async () => {
    const store = handoffStore([null, new Uint8Array([1])]);
    await expect(
      waitForRuntimeHandoff(store, sha, async () => 'finished without a handoff')
    ).resolves.toBeUndefined();
  });

  it('keeps polling while the publication is still running', async () => {
    vi.useFakeTimers();
    const store = handoffStore([null, null, null, new Uint8Array([1])]);
    const probe = vi.fn(async () => null);
    const wait = waitForRuntimeHandoff(store, sha, probe);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(wait).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('still bounds the wait when publication status is unavailable', async () => {
    vi.useFakeTimers();
    const wait = waitForRuntimeHandoff(handoffStore([null]), sha);
    const rejection = expect(wait).rejects.toThrow('did not complete within 45 minutes');
    await vi.advanceTimersByTimeAsync(46 * 60_000);
    await rejection;
  });
});
it('accepts JSONC comments and trailing commas but rejects preinstalled configuration', async () => {
  const f = await checkout(
    config().slice(0, -1) + ', // supported JSONC\n}',
    undefined,
    'preinstalled'
  );
  await expect(main(['production', f.sha], f.root)).rejects.toMatchObject({
    issues: [
      expect.objectContaining({
        code: 'invalid_value',
        path: ['default', 'mode'],
        values: ['downloaded'],
      }),
    ],
  });
  expect(lookup).not.toHaveBeenCalled();
});
