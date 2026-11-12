import { describe, expect, it } from 'vitest';
import { supervisorStartup } from '../../test/fixtures/supervisor-startup.js';
import {
  createRetiredCloudflareProviderAdapter,
  RetiredSandboxProviderError,
} from './retired-cloudflare-provider.js';

const intent = { intentId: 'attempt-1', createdAt: 0, allocationName: 'ses-abcdef' };

describe('retired Cloudflare provider adapter', () => {
  it.each([
    [
      'create',
      (adapter: ReturnType<typeof createRetiredCloudflareProviderAdapter>) =>
        adapter.create(intent),
    ],
    [
      'launch',
      (adapter: ReturnType<typeof createRetiredCloudflareProviderAdapter>) =>
        adapter.launch('ses-abcdef', { command: supervisorStartup(), env: {} }),
    ],
    [
      'admission',
      (adapter: ReturnType<typeof createRetiredCloudflareProviderAdapter>) =>
        adapter.ensureBillingAdmission('ses-abcdef'),
    ],
  ] as const)('refuses %s compute with a specific retirement error', async (_name, run) => {
    await expect(run(createRetiredCloudflareProviderAdapter())).rejects.toBeInstanceOf(
      RetiredSandboxProviderError
    );
  });

  it('reports a persisted pin terminal for observe/stop and never leases compute', async () => {
    const adapter = createRetiredCloudflareProviderAdapter();

    await expect(adapter.observe('persisted-ref')).resolves.toEqual({
      status: 'terminal',
      providerRef: 'persisted-ref',
    });
    await expect(adapter.observe(null)).resolves.toEqual({ status: 'terminal' });
    await expect(adapter.stop('persisted-ref')).resolves.toBe('terminal');
    await expect(adapter.ensureLeaseAtLeast('persisted-ref', 60_000)).resolves.toBeUndefined();
    expect(adapter.describeRuntime).toBeUndefined();
    expect(adapter.environmentSnapshots).toBeUndefined();
  });
});
