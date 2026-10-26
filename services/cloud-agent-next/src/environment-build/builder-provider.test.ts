import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import type {
  ContainersBuilderLaunchInput,
  SandboxContainers,
} from '../sandbox-containers/SandboxContainers.js';
import { downloadedStartup } from '../sandbox-control/downloaded-startup.js';
import { builderInstance, createBuilderProvider } from './builder-provider.js';

vi.mock('../sandbox-control/downloaded-startup.js', () => ({ downloadedStartup: vi.fn() }));
const allocation = {
  sandboxId: 'sbx-builder',
  allocationId: 'allocation',
  instance: 'standard-4' as const,
};
const runner = { url: 'https://worker.test/environment-build/test', credential: 'synthetic' };
const command = { argv: ['/bin/sh', '-c', 'download-selected-builder'] };

function harness(env: Partial<Env>) {
  const launchBuilder = vi.fn(async (_input: ContainersBuilderLaunchInput) => ({
    started: true,
    startSource: 'image' as const,
  }));
  const ensureLeaseAtLeast = vi.fn(async () => undefined);
  const containers = {
    getByName: () => ({ launchBuilder, ensureLeaseAtLeast }),
  } as unknown as DurableObjectNamespace<SandboxContainers>;
  const provider = createBuilderProvider({
    containers,
    env: { WORKER_URL: 'https://worker.test', ...env } as Env,
  });
  return { provider, launchBuilder };
}

beforeEach(() => vi.mocked(downloadedStartup).mockReset().mockResolvedValue(command));

describe('environment builder startup selection', () => {
  it('uses setup size only when setup commands exist', () => {
    expect(builderInstance(['install'])).toBe('standard-4');
    expect(builderInstance([])).toBe('standard-3');
  });

  it('keeps preinstalled startup even when a release descriptor exists', async () => {
    const { provider, launchBuilder } = harness({
      RUNTIME_RELEASE_DESCRIPTOR: 'available-release',
    });
    await provider.launch(allocation, { runner, deadlineAt: 100 });
    expect(downloadedStartup).not.toHaveBeenCalled();
    expect(launchBuilder.mock.calls[0]?.[0]).toMatchObject({
      command: { argv: ['/usr/local/bin/bun', '/usr/local/bin/kilocode-environment-builder.js'] },
      runner,
    });
    expect(await provider.runtimeReleaseId()).toBeNull();
  });

  it.each(['all-in-one', 'runtime-free'] as const)(
    'uses the current installer for the %s image',
    async image => {
      const { provider, launchBuilder } = harness({
        RUNTIME_STARTUP_MODE: 'downloaded',
        NATIVE_RUNTIME_IMAGE: image,
        RUNTIME_RELEASE_DESCRIPTOR: 'release',
      });
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
    }
  );

  it('keeps an existing descriptor digest as the release identity', async () => {
    const digest = 'a'.repeat(64);
    const { provider } = harness({
      RUNTIME_STARTUP_MODE: 'downloaded',
      RUNTIME_RELEASE_DESCRIPTOR: digest,
    });
    expect(await provider.runtimeReleaseId()).toBe(digest);
  });

  it('rejects runtime-free startup without a downloadable release before starting a builder', async () => {
    const { provider, launchBuilder } = harness({ NATIVE_RUNTIME_IMAGE: 'runtime-free' });
    await expect(provider.launch(allocation, { runner, deadlineAt: 100 })).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(launchBuilder).not.toHaveBeenCalled();
  });
});
