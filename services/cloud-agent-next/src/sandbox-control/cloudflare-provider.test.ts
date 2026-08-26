import { describe, expect, it, vi } from 'vitest';
import {
  createCloudflareProviderAdapter,
  type CloudflareSandboxHandle,
} from './cloudflare-provider.js';

function fakeSandbox(overrides: Partial<CloudflareSandboxHandle> = {}): CloudflareSandboxHandle {
  return {
    renewActivityTimeout: () => undefined,
    destroy: async () => undefined,
    isContainerRunning: async () => true,
    startProcess: async () => ({ id: 'proc_1' }),
    ...overrides,
  };
}

describe('cloudflare provider adapter', () => {
  it('wakes the container, starts the control wrapper, and returns the sandbox id', async () => {
    const startProcess = vi.fn().mockResolvedValue({ id: 'proc_1' });
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox: () => fakeSandbox({ startProcess }),
    });
    await expect(
      provider.create({
        intentId: 'op_1',
        env: {
          SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
        },
      })
    ).resolves.toEqual({ providerRef: 'sbx_1' });
    expect(startProcess).toHaveBeenCalledWith(
      'bun run /usr/local/bin/kilocode-control-wrapper.js',
      {
        cwd: '/',
        env: {
          SANDBOX_CONTROL_URL: 'wss://example.test/sandbox-control/sbx_1',
          SANDBOX_CONTROL_CREDENTIAL: 'secret',
          WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
        },
      }
    );
    expect(String(startProcess.mock.calls[0]?.[0])).not.toContain('kilocode-wrapper.js');
  });

  it('returns the instance ref even when the control wrapper fails to start', async () => {
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox: () =>
        fakeSandbox({
          startProcess: async () => {
            throw new Error('start failed');
          },
        }),
    });
    await expect(
      provider.create({ intentId: 'op_1', env: { SANDBOX_CONTROL_CREDENTIAL: 'secret' } })
    ).resolves.toEqual({ providerRef: 'sbx_1' });
  });

  it('maps running/not-running/failed lookup to three-valued observe', async () => {
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox: id => {
        if (id === 'missing') throw new Error('not found');
        return fakeSandbox({
          isContainerRunning: async () => id === 'running',
        });
      },
    });
    await expect(provider.observe('running')).resolves.toBe('active');
    await expect(provider.observe('stopped')).resolves.toBe('terminal');
    await expect(provider.observe('missing')).resolves.toBe('unknown');
    await expect(provider.observe(null)).resolves.toBe('terminal');
  });

  it('renews the lease on the given ref', async () => {
    const renewed: string[] = [];
    const provider = createCloudflareProviderAdapter({
      sandboxId: 'sbx_1',
      getSandbox: id =>
        fakeSandbox({
          renewActivityTimeout: () => {
            renewed.push(id);
          },
        }),
    });
    await provider.ensureLeaseAtLeast('sbx_1', 360_000);
    expect(renewed).toEqual(['sbx_1']);
  });
});
