import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type {
  ContainersBuilderLaunchInput,
  SandboxContainers,
} from '../sandbox-containers/SandboxContainers.js';
import { downloadedStartup } from '../sandbox-control/downloaded-startup.js';
import {
  builderInstance,
  builderRuntimeUnsupportedReason,
  createBuilderProvider,
} from './builder-provider.js';

vi.mock('../sandbox-control/downloaded-startup.js', () => ({ downloadedStartup: vi.fn() }));
const allocation = {
  sandboxId: 'sbx-builder',
  allocationId: 'allocation',
  instance: 'standard-4' as const,
};
const runner = { url: 'https://worker.test/environment-build/test', credential: 'synthetic' };
const command = { argv: ['/bin/sh', '-c', 'download-selected-builder'] };

const runtimeEnv = {
  RUNTIME_STARTUP_MODE: 'downloaded',
  NATIVE_RUNTIME_IMAGE: 'runtime-free',
  RUNTIME_RELEASE_DESCRIPTOR: 'release',
  RUNTIME_RELEASE_BUCKET: {} as R2Bucket,
} satisfies Partial<Env>;

function harness(env: Partial<Env> = {}) {
  const launchBuilder = vi.fn(async (_input: ContainersBuilderLaunchInput) => ({
    started: true,
    startSource: 'image' as const,
  }));
  const ensureLeaseAtLeast = vi.fn(async () => undefined);
  const currentImage = vi.fn(async () => 'registry.example/runtime-free@sha256:base');
  const containers = {
    getByName: () => ({ launchBuilder, ensureLeaseAtLeast, currentImage }),
  } as unknown as DurableObjectNamespace<SandboxContainers>;
  const provider = createBuilderProvider({
    containers,
    env: { WORKER_URL: 'https://worker.test', ...runtimeEnv, ...env } as Env,
  });
  return { provider, launchBuilder, currentImage };
}

beforeEach(() => vi.mocked(downloadedStartup).mockReset().mockResolvedValue(command));

describe('environment builder startup selection', () => {
  it('uses setup size only when setup commands exist', () => {
    expect(builderInstance(['install'])).toBe('standard-4');
    expect(builderInstance([])).toBe('standard-3');
  });

  it.each([
    { RUNTIME_STARTUP_MODE: undefined },
    { RUNTIME_STARTUP_MODE: 'preinstalled' },
    { NATIVE_RUNTIME_IMAGE: 'all-in-one' },
    { RUNTIME_RELEASE_DESCRIPTOR: undefined },
    { RUNTIME_RELEASE_BUCKET: undefined },
  ] satisfies Partial<Env>[])(
    'rejects builds without the split runtime configuration: %j',
    async overrides => {
      const { provider, launchBuilder } = harness(overrides);
      expect(
        builderRuntimeUnsupportedReason({ ...runtimeEnv, ...overrides } as Env)
      ).not.toBeNull();
      await expect(provider.launch(allocation, { runner, deadlineAt: 100 })).rejects.toMatchObject({
        code: 'invalid_configuration',
      });
      expect(downloadedStartup).not.toHaveBeenCalled();
      expect(launchBuilder).not.toHaveBeenCalled();
    }
  );

  it('uses the downloaded builder independently of the interactive session cohort', async () => {
    const { provider, launchBuilder } = harness({
      RUNTIME_INTERACTIVE_ORG_IDS: '22222222-2222-4222-8222-222222222222',
    });
    expect(builderRuntimeUnsupportedReason(runtimeEnv as Env)).toBeNull();
    await provider.launch(allocation, { runner, deadlineAt: 100 });
    expect(downloadedStartup).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: 'release',
        sandboxId: allocation.sandboxId,
        allocationId: allocation.allocationId,
        deadlineAt: 100,
        mainProcess: 'environment-builder',
      })
    );
    expect(launchBuilder.mock.calls[0]?.[0]).toMatchObject({ command, runner, deadlineAt: 100 });
  });

  it('reads snapshot compatibility from the runtime-free image', async () => {
    const { provider, currentImage } = harness();
    expect(await provider.currentImage(allocation.sandboxId)).toBe(
      'registry.example/runtime-free@sha256:base'
    );
    expect(currentImage).toHaveBeenCalledWith('runtime-free');
  });

  it('returns no release identity when publication is unavailable', async () => {
    const { provider } = harness({ RUNTIME_RELEASE_DESCRIPTOR: undefined });
    expect(await provider.runtimeReleaseId()).toBeNull();
  });

  it('keeps an existing descriptor digest as the release identity', async () => {
    const digest = 'a'.repeat(64);
    const { provider } = harness({
      RUNTIME_STARTUP_MODE: 'downloaded',
      RUNTIME_RELEASE_DESCRIPTOR: digest,
    });
    expect(await provider.runtimeReleaseId()).toBe(digest);
  });
});
